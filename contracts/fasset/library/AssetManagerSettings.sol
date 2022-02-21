// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

import "../interface/IAttestationClient.sol";


library AssetManagerSettings {
    struct Settings {
        // Required contracts.
        // Can be changed by AddressUpdater.
        IAttestationClient attestationClient;
        
        // Wrapped NAT specific settings
        uint16 wnatIndex;  // immutable?
        
        // Managed f-asset index in FtsoRegistry
        uint16 assetIndex;  // immutable?
        
        // Must match attestation data chainId.
        // immutable
        uint32 chainId;

        // Collateral reservation fee that must be paid by the minter.
        // Payment is in NAT, but is proportional to the value of assets to be minted.
        uint16 collateralReservationFeeBIPS;
        
        // Collateral reservation fee is burned on successful minting.
        address payable burnAddress;

        // Asset unit value (e.g. 1 BTC or 1 ETH) in UBA = 10 ** assetToken.decimals()
        uint64 assetUnitUBA;
        
        // the granularity in which lots are measured = the value of AMG (asset minting granularity) in UBA
        // can only be changed via redeploy of AssetManager
        uint64 assetMintingGranularityUBA;
        
        // Lot size in asset minting granularity. May change, which affects subsequent mintings and redemptions.
        uint64 lotSizeAMG;
        
        // Minimum collateral ratio for new agents.
        uint16 initialMinCollateralRatioBIPS;

        // Collateral call band - CCB
        uint16 liquidationMinCollateralCallBandBIPS;
        
        // Minimum collateral ratio required to get agent out of liquidation.
        uint16 liquidationMinCollateralRatioBIPS;
        
        // Number of underlying blocks that the minter or agent is allowed to pay underlying value.
        // If payment not reported in that time, minting/redemption can be challenged and default action triggered.
        // CAREFUL: Count starts from the current proved block height, so the minters and agents should 
        // make sure that current block height is fresh, otherwise they might not have enough time for payment.
        uint64 underlyingBlocksForPayment;
        
        // Minimum time to allow agent to pay for redemption or minter to pay for minting.
        // This is useful for fast chains, when there can be more than one block per second.
        // Redemption/minting payment failure can be called only after underlyingSecondsForPayment have elapsed
        // on underlying chain.
        // CAREFUL: Count starts from the current proved block timestamp, so the minters and agents should 
        // make sure that current block timestamp is fresh, otherwise they might not have enough time for payment.
        // This is partially mitigated by adding local duration since the last block height update to
        // the current underlying block timestamp.
        uint64 underlyingSecondsForPayment;

        // Number of underlying blocks that the agent is allowed to perform allowed underlying payment
        // (e.g. fee withdrawal). It can be much longer than the limit for required payments - it's only here
        // to make sure payment happens before payment verification data is expired in a few days.
        uint64 underlyingBlocksForAllowedPayment;
        
        // Redemption fee in underlying currency base amount (UBA).
        uint16 redemptionFeeBips;
        
        // On redemption underlying payment failure, redeemer is compensated with
        // redemption value recalculated in flare/sgb times redemption failure factor.
        // Expressed in BIPS, e.g. 12000 for factor of 1.2.
        uint32 redemptionFailureFactorBIPS;
        
        // To prevent unbounded work, the number of tickets redeemed in a single request is limited.
        uint16 maxRedeemedTickets;
        
        // After illegal payment challenge against an agent is triggered, there is some time to needed to wait 
        // to allow the agent to respond with legal payment report (e.g. redemption payment; for fee withdrawal
        // there needs to be prior announcement.)
        uint64 paymentChallengeWaitMinSeconds;
        
        // Challenge reward can be composed of two part - fixed and proportional (any of them can be zero).
        // This is the proportional part (in BIPS).
        uint16 paymentChallengeRewardBIPS;
        
        // Challenge reward can be composed of two part - fixed and proportional (any of them can be zero).
        // This is the fixed part (in underlying AMG, so that we can easily set it as some percent of lot size).
        uint64 paymentChallengeRewardAMG;

        // Agent has to announce any collateral withdrawal and then wait for at least withdrawalWaitMinSeconds.
        // This prevents challenged agent to remove all collateral before challenge can be proved.
        uint64 withdrawalWaitMinSeconds;

        // In first phase of liquidation, liquidator is compensated with
        // value recalculated in flare/sgb times liquidation price premium factor.
        // Expressed in BIPS, e.g. 12500 for factor of 1.25.
        uint16 liquidationPricePremiumBIPS;

        // After first phase, instead of price premium, percentage of collateral is offered.
        // Expressed in BIPS, e.g. [6000, 8000, 10000] for 60%, 80% and 100%.
        // CAREFUL: values in array must increase and be <= 10000
        uint16[] liquidationCollateralPremiumBIPS;

        // If there was no liquidator for the current liquidation offer, 
        // go to the next step of liquidation after a certain period of time.
        uint64 newLiquidationStepAfterMinSeconds;
        
        // for some chains (e.g. Ethereum) we require that agent proves that underlying address is an EOA address
        // this must be done by presenting a payment proof from that address
        bool requireEOAAddressProof;
    }

}
