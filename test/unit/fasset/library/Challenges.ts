import { expectEvent, expectRevert, time } from "@openzeppelin/test-helpers";
import { AgentSettings, AssetManagerSettings, CollateralToken } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { filterEvents, requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { toBN, toBNExp, toWei } from "../../../../lib/utils/helpers";
import { AgentVaultInstance, AssetManagerInstance, ERC20MockInstance, FAssetInstance, WNatInstance } from "../../../../typechain-truffle";
import { testChainInfo } from "../../../integration/utils/TestChainInfo";
import { newAssetManager } from "../../../utils/fasset/DeployAssetManager";
import { MockChain, MockChainWallet } from "../../../utils/fasset/MockChain";
import { MockStateConnectorClient } from "../../../utils/fasset/MockStateConnectorClient";
import { getTestFile } from "../../../utils/test-helpers";
import { createEncodedTestLiquidationSettings, createTestAgent, createTestCollaterals, createTestContracts, createTestFtsos, createTestSettings, TestFtsos, TestSettingsContracts } from "../test-settings";

const CollateralPool = artifacts.require('CollateralPool');
const CollateralPoolToken = artifacts.require('CollateralPoolToken');

contract(`Challenges.sol; ${getTestFile(__filename)}; Challenges basic tests`, async accounts => {
    const governance = accounts[10];
    let assetManagerController = accounts[11];
    let contracts: TestSettingsContracts;
    let assetManager: AssetManagerInstance;
    let fAsset: FAssetInstance;
    let wNat: WNatInstance;
    let usdc: ERC20MockInstance;
    let ftsos: TestFtsos;
    let settings: AssetManagerSettings;
    let collaterals: CollateralToken[];
    let chain: MockChain;
    let wallet: MockChainWallet;
    let stateConnectorClient: MockStateConnectorClient;
    let attestationProvider: AttestationHelper;

    let agentVault: AgentVaultInstance;
    let agentVault2: AgentVaultInstance;

    let agentTxHash: string;
    let agentTxProof: any;

    // addresses
    const underlyingBurnAddr = "Burn";
    const agentOwner1 = accounts[20];
    const underlyingAgent1 = "Agent1";  // addresses on mock underlying chain can be any string, as long as it is unique
    const whitelistedAccount = accounts[1];
    const underlyingRedeemer = "Redeemer";
    const agentOwner2 = accounts[40];
    const underlyingAgent2 = "Agent2";
    const underlyingMinterAddress = "Minter";
    const minterAddress1 = accounts[30];
    const underlyingRedeemer1 = "Redeemer1";
    const redeemerAddress1 = accounts[50]


    function createAgent(owner: string, underlyingAddress: string, options?: Partial<AgentSettings>) {
        const class1CollateralToken = options?.class1CollateralToken ?? usdc.address;
        return createTestAgent({ assetManager, settings, chain, wallet, attestationProvider }, owner, underlyingAddress, class1CollateralToken, options);
    }

    async function depositAndMakeAgentAvailable(agentVault: AgentVaultInstance, owner: string) {
        // depositCollateral
        const fullAgentCollateral = toWei(3e8);
        await agentVault.depositNat({ from: owner, value: toBN(fullAgentCollateral) });
        await usdc.mintAmount(owner, toBNExp(10000, 18));
        await usdc.increaseAllowance(agentVault.address, toBNExp(10000, 18), { from: owner });
        await agentVault.depositCollateral(usdc.address, toBNExp(10000, 18), { from: owner });
        await depositPoolTokens(agentVault, owner, fullAgentCollateral);
        await assetManager.makeAgentAvailable(agentVault.address, { from: owner });
    }

    async function updateUnderlyingBlock() {
        const proof = await attestationProvider.proveConfirmedBlockHeightExists();
        await assetManager.updateCurrentBlock(proof);
    }

    async function mintAndRedeem(agentVault: AgentVaultInstance, chain: MockChain, underlyingMinterAddress: string, minterAddress: string, underlyingRedeemerAddress: string, redeemerAddress: string, updateBlock: boolean) {
        // minter
        chain.mint(underlyingMinterAddress, toBNExp(10000, 18));
        if (updateBlock) await updateUnderlyingBlock();
        // perform minting
        const lots = 3;
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        const crFee = await assetManager.collateralReservationFee(lots);
        const resAg = await assetManager.reserveCollateral(agentVault.address, lots, agentInfo.feeBIPS, { from: minterAddress, value: crFee });
        const crt = requiredEventArgs(resAg, 'CollateralReserved');
        const paymentAmount = crt.valueUBA.add(crt.feeUBA);
        const txHash = await wallet.addTransaction(underlyingMinterAddress, crt.paymentAddress, paymentAmount, crt.paymentReference);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinterAddress, crt.paymentAddress);
        const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress });
        const minted = requiredEventArgs(res, 'MintingExecuted');
        // redeemer "buys" f-assets
        await fAsset.transfer(redeemerAddress, minted.mintedAmountUBA, { from: minterAddress });
        // redemption request
        const resR = await assetManager.redeem(lots, underlyingRedeemerAddress, { from: redeemerAddress });
        const redemptionRequests = filterEvents(resR, 'RedemptionRequested').map(e => e.args);
        const request = redemptionRequests[0];
        return request;
    }

    async function depositPoolTokens(agentVault: AgentVaultInstance, owner: string, tokens: BN) {
        const pool = await CollateralPool.at(await assetManager.getCollateralPool(agentVault.address));
        const poolToken = await CollateralPoolToken.at(await pool.poolToken());
        await pool.enter(0, false, { value: tokens, from: owner }); // owner will get at least `tokens` of tokens
        await poolToken.transfer(agentVault.address, tokens, { from: owner });
    }

    beforeEach(async () => {
        const ci = testChainInfo.eth;
        contracts = await createTestContracts(governance);
        // save some contracts as globals
        ({ wNat } = contracts);
        usdc = contracts.stablecoins.USDC;
        // create FTSOs for nat, stablecoins and asset and set some price
        ftsos = await createTestFtsos(contracts.ftsoRegistry, ci);
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        stateConnectorClient = new MockStateConnectorClient(contracts.stateConnector, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(stateConnectorClient, chain, ci.chainId);
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true });
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, createEncodedTestLiquidationSettings());

        agentVault = await createAgent(agentOwner1, underlyingAgent1);
        agentVault2 = await createAgent(agentOwner2, underlyingAgent2);

        agentTxHash = await wallet.addTransaction(
            underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(1));
            agentTxProof = await attestationProvider.proveBalanceDecreasingTransaction(agentTxHash, underlyingAgent1);
    });

  describe("illegal payment challenge", () => {

        it("should succeed challenging illegal payment", async() => {
            let txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(0));
            let proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            let res = await assetManager.illegalPaymentChallenge(
                proof, agentVault.address, { from: whitelistedAccount });
            expectEvent(res, "IllegalPaymentConfirmed");
        });

        it("should succeed challenging illegal withdrawal payment", async() => {
            let txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.announcedWithdrawal(1));
            let proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            let res = await assetManager.illegalPaymentChallenge(
                proof, agentVault.address, { from: whitelistedAccount });
            expectEvent(res, "IllegalPaymentConfirmed");
        });

        it("should not succeed challenging illegal payment - verified transaction too old", async() => {
            let txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(0));
            let proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);

            await time.increase(14 * 86400);
            let res = assetManager.illegalPaymentChallenge(
                proof, agentVault.address, { from: whitelistedAccount });
            await expectRevert(res, "verified transaction too old")
        });

        it("should not succeed challenging illegal payment - chlg: not agent's address", async () => {
            let txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(0));
            let proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);

            let res = assetManager.illegalPaymentChallenge(
                proof, agentVault2.address, { from: whitelistedAccount });
            await expectRevert(res, "chlg: not agent's address")
        });

        it("should not succeed challenging illegal payment - matching ongoing announced pmt", async () => {
            const resp = await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const req = requiredEventArgs(resp, 'UnderlyingWithdrawalAnnounced')
            const txHash = await wallet.addTransaction(underlyingAgent1, underlyingRedeemer, 1, req.paymentReference);

            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const res = assetManager.illegalPaymentChallenge(proof, agentVault.address, { from: whitelistedAccount });
            await expectRevert(res, 'matching ongoing announced pmt');
        });

    });

    describe("double payment challenge", () => {

        it("should revert on transactions with same references", async() => {
            let txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(2));
            let proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            let promise = assetManager.doublePaymentChallenge(
                agentTxProof, proof, agentVault.address, { from: whitelistedAccount });
            await expectRevert(promise, "challenge: not duplicate");
        });

        it("should revert on wrong agent's address", async() => {
            let txHash = await wallet.addTransaction(
                underlyingAgent2, underlyingRedeemer, 1, PaymentReference.redemption(2));
            let proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent2);
            let promise = assetManager.doublePaymentChallenge(
                agentTxProof, proof, agentVault.address, { from: whitelistedAccount });
            await expectRevert(promise, "chlg 2: not agent's address");
        });

        it("should revert on same references", async() => {
            let promise = assetManager.doublePaymentChallenge(
                agentTxProof, agentTxProof, agentVault.address, { from: whitelistedAccount });
            await expectRevert(promise, "chlg dbl: same transaction");
        });

        it("should revert on not agent's address", async() => {
            let txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(1));
            let proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            let res = assetManager.doublePaymentChallenge(
                agentTxProof, proof, agentVault2.address, { from: whitelistedAccount });
            await expectRevert(res, "chlg 1: not agent's address");
        });

        it("should successfully challenge double payments", async() => {
            let txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(1));
            let proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            let res = await assetManager.doublePaymentChallenge(
                agentTxProof, proof, agentVault.address, { from: whitelistedAccount });
            expectEvent(res, 'DuplicatePaymentConfirmed', {
                agentVault: agentVault.address, transactionHash1: agentTxHash, transactionHash2: txHash
            });
        });
    });

   describe("payments making free balance negative challange", () => {

        it("should revert repeated transaction", async() => {
            // payment references match
            let prms1 = assetManager.freeBalanceNegativeChallenge(
                [agentTxProof, agentTxProof], agentVault.address, { from: whitelistedAccount });
            await expectRevert(prms1, "mult chlg: repeated transaction");
        });

        it("should revert if transaction has different sources", async() => {
            let txHashA2 = await wallet.addTransaction(
                underlyingAgent2, underlyingRedeemer, 1, PaymentReference.redemption(2));
            let proofA2 = await attestationProvider.proveBalanceDecreasingTransaction(txHashA2, underlyingAgent2);
            // transaction sources are not the same agent
            let prmsW = assetManager.freeBalanceNegativeChallenge(
                [agentTxProof, proofA2], agentVault.address, { from: whitelistedAccount });
            await expectRevert(prmsW, "mult chlg: not agent's address");
        });

        it("should revert - mult chlg: payment confirmed", async () => {
            // init
            await depositAndMakeAgentAvailable(agentVault, agentOwner1);
            const request = await mintAndRedeem(agentVault, chain, underlyingMinterAddress, minterAddress1, underlyingRedeemer1, redeemerAddress1, true);
            //perform redemption payment
            const paymentAmt = request.valueUBA.sub(request.feeUBA);
            const tx1Hash = await wallet.addTransaction(underlyingAgent1, request.paymentAddress, paymentAmt, request.paymentReference);
            const proofR = await attestationProvider.provePayment(tx1Hash, underlyingAgent1, request.paymentAddress);
            await assetManager.confirmRedemptionPayment(proofR, request.requestId, { from: agentOwner1 });

            let proof2 = await attestationProvider.proveBalanceDecreasingTransaction(tx1Hash, underlyingAgent1);

            let res = assetManager.freeBalanceNegativeChallenge([agentTxProof, proof2], agentVault.address, { from: whitelistedAccount });
            await expectRevert(res, "mult chlg: payment confirmed");
        });

        it("should revert - mult chlg: enough free balance", async () => {
            // init
            await depositAndMakeAgentAvailable(agentVault, agentOwner1);
            const request = await mintAndRedeem(agentVault, chain, underlyingMinterAddress, minterAddress1, underlyingRedeemer1, redeemerAddress1, true);
            //perform redemption payment
            const paymentAmt = request.valueUBA.sub(request.feeUBA);
            const tx1Hash = await wallet.addTransaction(underlyingAgent1, request.paymentAddress, paymentAmt, request.paymentReference);
            const proofR = await attestationProvider.provePayment(tx1Hash, underlyingAgent1, request.paymentAddress);
            await assetManager.confirmRedemptionPayment(proofR, request.requestId, { from: agentOwner1 });

            let txHash2 = await wallet.addTransaction(underlyingAgent1, underlyingRedeemer, 1, PaymentReference.announcedWithdrawal(2));
            let proof2 = await attestationProvider.proveBalanceDecreasingTransaction(txHash2, underlyingAgent1);

            let res = assetManager.freeBalanceNegativeChallenge([agentTxProof, proof2], agentVault.address, { from: whitelistedAccount });
            await expectRevert(res, "mult chlg: enough free balance");
        });

        it("should succeed in challenging payments if they make balance negative", async() => {
            const info = await assetManager.getAgentInfo(agentVault.address);
            let txHash2 = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.announcedWithdrawal(2));
            let proof2 = await attestationProvider.proveBalanceDecreasingTransaction(txHash2, underlyingAgent1);
            // successful challenge
            let res1 = await assetManager.freeBalanceNegativeChallenge(
                [agentTxProof, proof2], agentVault.address, { from: whitelistedAccount });
            expectEvent(res1, 'UnderlyingFreeBalanceNegative', {agentVault: agentVault.address});
       });
    });

});
