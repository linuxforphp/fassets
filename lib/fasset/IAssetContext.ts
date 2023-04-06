import { AssetManagerControllerInstance, AssetManagerInstance, ERC20MockInstance, FAssetInstance, FtsoManagerMockInstance, FtsoMockInstance, FtsoRegistryMockInstance, WNatInstance } from "../../typechain-truffle";
import { AttestationHelper } from "../underlying-chain/AttestationHelper";
import { IBlockChain } from "../underlying-chain/interfaces/IBlockChain";
import { UnderlyingChainEvents } from "../underlying-chain/UnderlyingChainEvents";
import { ContractWithEvents } from "../utils/events/truffle";
import { ChainInfo } from "./ChainInfo";

export type AddressUpdaterEvents = import('../../typechain-truffle/AddressUpdater').AllEvents;
export type AssetManagerControllerEvents = import('../../typechain-truffle/AssetManagerController').AllEvents;
export type WNatEvents = import('../../typechain-truffle/WNat').AllEvents;
export type StateConnectorMockEvents = import('../../typechain-truffle/StateConnectorMock').AllEvents;
export type AgentVaultFactoryEvents = import('../../typechain-truffle/AgentVaultFactory').AllEvents;
export type CollateralPoolFactoryEvents = import('../../typechain-truffle/CollateralPoolFactory').AllEvents;
export type WhitelistEvents = import('../../typechain-truffle/Whitelist').AllEvents;
export type AttestationClientSCEvents = import('../../typechain-truffle/AttestationClientSC').AllEvents;
export type FtsoRegistryMockEvents = import('../../typechain-truffle/FtsoRegistryMock').AllEvents;
export type FtsoMockEvents = import('../../typechain-truffle/FtsoMock').AllEvents;
export type FtsoManagerMockEvents = import('../../typechain-truffle/FtsoManagerMock').AllEvents;
export type AssetManagerEvents = import('../../typechain-truffle/AssetManager').AllEvents;
export type FAssetEvents = import('../../typechain-truffle/FAsset').AllEvents;
export type ERC20Events = import('../../typechain-truffle/IERC20').AllEvents;

export interface IAssetContext {
    chainInfo: ChainInfo;
    chain: IBlockChain;
    chainEvents: UnderlyingChainEvents;
    attestationProvider: AttestationHelper;
    // contracts
    assetManagerController: ContractWithEvents<AssetManagerControllerInstance, AssetManagerControllerEvents>;
    ftsoRegistry: ContractWithEvents<FtsoRegistryMockInstance, FtsoRegistryMockEvents>;
    ftsoManager: ContractWithEvents<FtsoManagerMockInstance, FtsoManagerMockEvents>;
    wNat: ContractWithEvents<WNatInstance, WNatEvents>;
    natFtso: ContractWithEvents<FtsoMockInstance, FtsoMockEvents>;
    fAsset: ContractWithEvents<FAssetInstance, FAssetEvents>;
    assetManager: ContractWithEvents<AssetManagerInstance, AssetManagerEvents>;
    stablecoins: Record<string, ContractWithEvents<ERC20MockInstance, ERC20Events>>;
    ftsos: Record<string, ContractWithEvents<FtsoMockInstance, FtsoMockEvents>>;
}
