// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../../utils/lib/SafeMath64.sol";
import "../../utils/lib/SafePct.sol";
import "./data/AssetManagerState.sol";
import "./AMEvents.sol";
import "./Conversion.sol";
import "./AgentCollateral.sol";
import "./Liquidation.sol";

library AgentsExternal {
    using SafePct for uint256;
    using SafeCast for uint256;
    using AgentCollateral for Collateral.Data;
    using Agent for Agent.State;
    using Agents for Agent.State;

    modifier onlyAgentVaultOwner(address _agentVault) {
        Agents.requireAgentVaultOwner(_agentVault);
        _;
    }

    function convertDustToTicket(
        address _agentVault
    )
        external
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        Agent.State storage agent = Agent.get(_agentVault);
        // if dust is more than 1 lot, create a new redemption ticket
        if (agent.dustAMG >= state.settings.lotSizeAMG) {
            uint64 remainingDustAMG = agent.dustAMG % state.settings.lotSizeAMG;
            uint64 ticketValueAMG = agent.dustAMG - remainingDustAMG;
            Agents.createRedemptionTicket(agent, ticketValueAMG);
            Agents.changeDust(agent, remainingDustAMG);
        }
    }

    function depositExecuted(
        address _agentVault,
        IERC20 _token
    )
        external
    {
        Agent.State storage agent = Agent.get(_agentVault);
        require(msg.sender == _agentVault || msg.sender == address(agent.collateralPool),
            "only agent vault or pool");
        // try to pull agent out of liquidation
        if (agent.isCollateralToken(_token)) {
            Liquidation.endLiquidationIfHealthy(agent);
        }
    }

    // _kind will always be VAULT or AGENT_POOL (limited in AssetManager)
    function announceWithdrawal(
        Collateral.Kind _kind,
        address _agentVault,
        uint256 _amountWei
    )
        external
        onlyAgentVaultOwner(_agentVault)
        returns (uint256)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        // only agents that are not being liquidated can withdraw
        // however, if the agent is in FULL_LIQUIDATION and totally liquidated,
        // the withdrawals must still be possible, otherwise the collateral gets locked forever
        require(agent.status == Agent.Status.NORMAL || agent.totalBackedAMG() == 0, "withdrawal ann: invalid status");
        Agent.WithdrawalAnnouncement storage withdrawal = agent.withdrawalAnnouncement(_kind);
        if (_amountWei > withdrawal.amountWei) {
            AssetManagerSettings.Data storage settings = AssetManagerState.getSettings();
            Collateral.Data memory collateralData = AgentCollateral.singleCollateralData(agent, _kind);
            // announcement increased - must check there is enough free collateral and then lock it
            // in this case the wait to withdrawal restarts from this moment
            uint256 increase = _amountWei - withdrawal.amountWei;
            require(increase <= collateralData.freeCollateralWei(agent), "withdrawal: value too high");
            withdrawal.allowedAt = (block.timestamp + settings.withdrawalWaitMinSeconds).toUint64();
        } else {
            // announcement decreased or cancelled
            // if value is 0, we cancel announcement completely (i.e. set announcement time to 0)
            // otherwise, for decreasing announcement, we can safely leave announcement time unchanged
            if (_amountWei == 0) {
                withdrawal.allowedAt = 0;
            }
        }
        withdrawal.amountWei = _amountWei.toUint128();
        if (_kind == Collateral.Kind.VAULT) {
            emit AMEvents.VaultCollateralWithdrawalAnnounced(_agentVault, _amountWei, withdrawal.allowedAt);
        } else {
            emit AMEvents.PoolTokenRedemptionAnnounced(_agentVault, _amountWei, withdrawal.allowedAt);
        }
        return withdrawal.allowedAt;
    }

    function beforeCollateralWithdrawal(
        IERC20 _token,
        address _agentVault,
        uint256 _amountWei
    )
        external
    {
        Agent.State storage agent = Agent.get(_agentVault);
        Collateral.Kind kind;
        if (_token == agent.getVaultCollateralToken()) {
            kind = Collateral.Kind.VAULT;
        } else if (_token == agent.collateralPool.poolToken()) {
            kind = Collateral.Kind.AGENT_POOL;
        } else {
            return;     // we don't care about other token withdrawals from agent vault
        }
        Agent.WithdrawalAnnouncement storage withdrawal = agent.withdrawalAnnouncement(kind);
        Collateral.Data memory collateralData = AgentCollateral.singleCollateralData(agent, kind);
        // only agents that are not being liquidated can withdraw
        // however, if the agent is in FULL_LIQUIDATION and totally liquidated,
        // the withdrawals must still be possible, otherwise the collateral gets locked forever
        require(agent.status == Agent.Status.NORMAL || agent.totalBackedAMG() == 0, "withdrawal: invalid status");
        require(withdrawal.allowedAt != 0, "withdrawal: not announced");
        require(_amountWei <= withdrawal.amountWei, "withdrawal: more than announced");
        require(block.timestamp >= withdrawal.allowedAt, "withdrawal: not allowed yet");
        AssetManagerSettings.Data storage settings = AssetManagerState.getSettings();
        require(block.timestamp <= withdrawal.allowedAt + settings.agentTimelockedOperationWindowSeconds,
            "withdrawal: too late");
        // Check that withdrawal doesn't reduce CR below mintingCR (withdrawal is not executed yet, but it balances
        // with the withdrawal announcement that is still in effect).
        // This would be equivalent to `collateralData.freeCollateralWei >= 0` if freeCollateralWei was signed,
        // but actually freeCollateralWei always returns positive part, so it cannot be used in this test.
        require(collateralData.lockedCollateralWei(agent) <= collateralData.fullCollateral, "withdrawal: CR too low");
        // (partially) clear withdrawal announcement
        uint256 remaining = withdrawal.amountWei - _amountWei;    // guarded by above require
        withdrawal.amountWei = uint128(remaining);
        if (remaining == 0) {
            withdrawal.allowedAt = 0;
        }
    }

    function upgradeWNatContract(
        address _agentVault
    )
        external
        onlyAgentVaultOwner(_agentVault)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        AssetManagerState.State storage state = AssetManagerState.get();
        IWNat wNat = IWNat(address(state.collateralTokens[state.poolCollateralIndex].token));
        // upgrade pool wnat
        if (agent.poolCollateralIndex != state.poolCollateralIndex) {
            agent.poolCollateralIndex = state.poolCollateralIndex;
            agent.collateralPool.upgradeWNatContract(wNat);
            emit AMEvents.AgentCollateralTypeChanged(_agentVault, uint8(CollateralType.Class.POOL), address(wNat));
        }
    }

    function switchVaultCollateral(
        address _agentVault,
        IERC20 _token
    )
        external
        onlyAgentVaultOwner(_agentVault)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        // check that old collateral is deprecated
        // TODO: could work without this check, but would need timelock, otherwise there can be
        //       withdrawal without announcement by switching, withdrawing and switching back
        CollateralTypeInt.Data storage currentCollateral = agent.getVaultCollateral();
        require(currentCollateral.validUntil != 0, "current collateral not deprecated");
        // set new collateral
        agent.setVaultCollateral(_token);
        emit AMEvents.AgentCollateralTypeChanged(_agentVault, uint8(CollateralType.Class.VAULT), address(_token));
    }

    function getAllAgents(
        uint256 _start,
        uint256 _end
    )
        external view
        returns (address[] memory _agents, uint256 _totalLength)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        _totalLength = state.allAgents.length;
        _end = Math.min(_end, _totalLength);
        _start = Math.min(_start, _end);
        _agents = new address[](_end - _start);
        for (uint256 i = _start; i < _end; i++) {
            _agents[i - _start] = state.allAgents[i];
        }
    }

    function isLockedVaultToken(
        address _agentVault,
        IERC20 _token
    )
        external view
        returns (bool)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        return _token == agent.getVaultCollateralToken() || _token == agent.collateralPool.poolToken();
    }

    function getFAssetsBackedByPool(address _agentVault)
        external view
        returns (uint256)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        return Conversion.convertAmgToUBA(agent.reservedAMG + agent.mintedAMG + agent.poolRedeemingAMG);
    }

    function getAgentVaultOwner(address _agentVault)
        external view
        returns (address _ownerManagementAddress)
    {
        return Agent.get(_agentVault).ownerManagementAddress;
    }
}
