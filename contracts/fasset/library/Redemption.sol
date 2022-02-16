// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "../../utils/lib/SafeMath64.sol";
import "../../utils/lib/SafeBips.sol";
import "../interface/IAgentVault.sol";
import "./AMEvents.sol";
import "./Conversion.sol";
import "./RedemptionQueue.sol";
import "./PaymentVerification.sol";
import "./Agents.sol";
import "./PaymentReports.sol";
import "./IllegalPaymentChallenge.sol";
import "./UnderlyingFreeBalance.sol";
import "./AssetManagerState.sol";
import "./AgentCollateral.sol";
import "./PaymentReference.sol";


library Redemption {
    using SafeBips for uint256;
    using RedemptionQueue for RedemptionQueue.State;
    using PaymentVerification for PaymentVerification.State;
    using AgentCollateral for AgentCollateral.Data;
    
    struct RedemptionRequest {
        bytes32 redeemerUnderlyingAddressHash;
        uint128 underlyingValueUBA;
        uint64 firstUnderlyingBlock;
        uint64 lastUnderlyingBlock;
        uint64 lastUnderlyingTimestamp;
        uint128 underlyingFeeUBA;
        uint64 valueAMG;
        address agentVault;
        address redeemer;
    }
    
    struct AgentRedemptionData {
        address agentVault;
        uint64 valueAMG;
    }

    struct AgentRedemptionList {
        AgentRedemptionData[] items;
        uint256 length;
    }

    function redeem(
        AssetManagerState.State storage _state,
        address _redeemer,
        uint64 _lots,
        bytes memory _redeemerUnderlyingAddress
    )
        external
        returns (uint64 _redeemedLots)
    {
        uint256 maxRedeemedTickets = _state.settings.maxRedeemedTickets;
        AgentRedemptionList memory redemptionList = AgentRedemptionList({ 
            length: 0, 
            items: new AgentRedemptionData[](maxRedeemedTickets)
        });
        _redeemedLots = 0;
        for (uint256 i = 0; i < maxRedeemedTickets && _redeemedLots < _lots; i++) {
            // each loop, firstTicketId will change since we delete the first ticket
            uint64 redeemedForTicket = _redeemFirstTicket(_state, _lots - _redeemedLots, redemptionList);
            if (redeemedForTicket == 0) {
                break;   // queue empty
            }
            _redeemedLots = _redeemedLots + redeemedForTicket;
        }
        require(_redeemedLots != 0, "redeem 0 lots");
        for (uint256 i = 0; i < redemptionList.length; i++) {
            _createRemptionRequest(_state, redemptionList.items[i], _redeemer, _redeemerUnderlyingAddress);
        }
        // notify redeemer of incomplete requests
        if (_redeemedLots < _lots) {
            emit AMEvents.RedemptionRequestIncomplete(_redeemer, _lots - _redeemedLots);
        }
    }

    function _redeemFirstTicket(
        AssetManagerState.State storage _state,
        uint64 _lots,
        AgentRedemptionList memory _list
    )
        private
        returns (uint64 _redeemedLots)
    {
        uint64 ticketId = _state.redemptionQueue.firstTicketId;
        if (ticketId == 0) {
            return 0;    // empty redemption queue
        }
        RedemptionQueue.Ticket storage ticket = _state.redemptionQueue.getTicket(ticketId);
        uint64 maxRedeemLots = ticket.valueAMG / _state.settings.lotSizeAMG;
        _redeemedLots = SafeMath64.min64(_lots, maxRedeemLots);
        uint64 redeemedAMG = _redeemedLots * _state.settings.lotSizeAMG;
        address agentVault = ticket.agentVault;
        // find list index for ticket's agent
        uint256 index = 0;
        while (index < _list.length && _list.items[index].agentVault != agentVault) {
            ++index;
        }
        // add to list item or create new item
        if (index < _list.length) {
            _list.items[index].valueAMG = _list.items[index].valueAMG + redeemedAMG;
        } else {
            _list.items[_list.length++] = AgentRedemptionData({ agentVault: agentVault, valueAMG: redeemedAMG });
        }
        // _removeFromTicket may delete ticket data, so we call it at end
        _removeFromTicket(_state, ticketId, redeemedAMG);
    }
    
    function _createRemptionRequest(
        AssetManagerState.State storage _state,
        AgentRedemptionData memory _data,
        address _redeemer,
        bytes memory _redeemerUnderlyingAddressString
    )
        private 
    {
        uint128 redeemedValueUBA = SafeCast.toUint128(Conversion.convertAmgToUBA(_state.settings, _data.valueAMG));
        uint64 requestId = ++_state.newRedemptionRequestId;
        (uint64 lastUnderlyingBlock, uint64 lastUnderlyingTimestamp) = _lastPaymentBlock(_state);
        uint128 redemptionFeeUBA = SafeCast.toUint128(
            SafeBips.mulBips(redeemedValueUBA, _state.settings.redemptionFeeBips));
        _state.redemptionRequests[requestId] = RedemptionRequest({
            redeemerUnderlyingAddressHash: keccak256(_redeemerUnderlyingAddressString),
            underlyingValueUBA: redeemedValueUBA,
            firstUnderlyingBlock: _state.currentUnderlyingBlock,
            lastUnderlyingBlock: lastUnderlyingBlock,
            lastUnderlyingTimestamp: lastUnderlyingTimestamp,
            underlyingFeeUBA: redemptionFeeUBA,
            redeemer: _redeemer,
            agentVault: _data.agentVault,
            valueAMG: _data.valueAMG
        });
        // decrease mintedAMG and mark it to redeemingAMG
        // do not add it to freeBalance yet (only after failed redemption payment)
        Agents.startRedeemingAssets(_state, _data.agentVault, _data.valueAMG);
        // emit event to remind agent to pay
        emit AMEvents.RedemptionRequested(_data.agentVault,
            requestId,
            _redeemerUnderlyingAddressString, 
            redeemedValueUBA - redemptionFeeUBA,
            lastUnderlyingBlock, 
            lastUnderlyingTimestamp,
            PaymentReference.redemption(requestId));
    }

    function getRedemptionRequest(
        AssetManagerState.State storage _state,
        uint64 _redemptionRequestId
    )
        internal view
        returns (RedemptionRequest storage _request)
    {
        require(_redemptionRequestId != 0, "invalid request id");
        _request = _state.redemptionRequests[_redemptionRequestId];
        require(_request.valueAMG != 0, "invalid request id");
    }
    
    function reportRedemptionPayment(
        AssetManagerState.State storage _state,
        PaymentVerification.UnderlyingPaymentInfo memory _paymentInfo,
        uint64 _redemptionRequestId
    )
        external
    {
        RedemptionRequest storage request = getRedemptionRequest(_state, _redemptionRequestId);
        Agents.requireAgentVaultOwner(request.agentVault);
        Agents.Agent storage agent = Agents.getAgent(_state, request.agentVault);
        // check details
        uint256 paymentValueUBA = uint256(request.underlyingValueUBA) - request.underlyingFeeUBA;
        PaymentVerification.validatePaymentDetails(_paymentInfo, 
            agent.underlyingAddressHash, request.redeemerUnderlyingAddressHash, paymentValueUBA);
        // report can be submitted several times (e.g. perhaps the gas price has to be raised for tx to be accepted),
        // but once the transaction has been proved, reporting it is pointless
        require(!PaymentVerification.transactionConfirmed(_state.paymentVerifications, _paymentInfo),
            "payment report after confirm");
        // create the report
        PaymentReports.createReport(_state.paymentReports, _paymentInfo);
        emit AMEvents.RedemptionPaymentReported(request.agentVault, request.redeemer,
            _paymentInfo.deliveredUBA, _paymentInfo.spentUBA, request.underlyingFeeUBA,
            _paymentInfo.underlyingBlock, _redemptionRequestId);
    }
    
    function confirmRedemptionPayment(
        AssetManagerState.State storage _state,
        PaymentVerification.UnderlyingPaymentInfo memory _paymentInfo,
        uint64 _redemptionRequestId
    )
        external
    {
        RedemptionRequest storage request = getRedemptionRequest(_state, _redemptionRequestId);
        require(PaymentReports.reportMatch(_state.paymentReports, _paymentInfo) != PaymentReports.ReportMatch.MISMATCH,
            "mismatching report exists");
        // we require the agent to trigger confirmation
        Agents.requireAgentVaultOwner(request.agentVault);
        // NOTE: we don't check that confirmation is on time - if it isn't, it's the agent's risk anyway,
        // since the redeemer can demand payment in collateral anytime
        Agents.Agent storage agent = Agents.getAgent(_state, request.agentVault);
        // confirm payment proof
        uint256 paymentValueUBA = uint256(request.underlyingValueUBA) - request.underlyingFeeUBA;
        PaymentVerification.validatePaymentDetails(_paymentInfo, 
            agent.underlyingAddressHash, request.redeemerUnderlyingAddressHash, paymentValueUBA);
        // record payment so that it cannot be used twice in redemption
        _state.paymentVerifications.confirmPayment(_paymentInfo);
        // record source decreasing transaction so that it cannot be challenged
        _state.paymentVerifications.confirmSourceDecreasingTransaction(_paymentInfo);
        // release agent collateral
        Agents.endRedeemingAssets(_state, request.agentVault, request.valueAMG);
        // update underlying free balance with fee and gas
        uint64 startBlockForTopup = _paymentInfo.underlyingBlock + _state.settings.underlyingBlocksForPayment;
        uint256 usedGas = PaymentVerification.usedGas(_paymentInfo);
        UnderlyingFreeBalance.updateFreeBalance(_state, request.agentVault,
            request.underlyingFeeUBA, usedGas, startBlockForTopup);
        // delete possible pending challenge
        IllegalPaymentChallenge.deleteChallenge(_state, _paymentInfo);
        emit AMEvents.RedemptionPerformed(request.agentVault, request.redeemer,
            _paymentInfo.deliveredUBA, usedGas, request.underlyingFeeUBA,
            _paymentInfo.underlyingBlock, _redemptionRequestId);
        // cleanup
        // delete report - not needed anymore since we store confirmation
        PaymentReports.deleteReport(_state.paymentReports, _paymentInfo);
        // delete redemption request at end when we don't need data any more
        delete _state.redemptionRequests[_redemptionRequestId];
    }
    
    function redemptionPaymentTimeout(
        AssetManagerState.State storage _state,
        IAttestationClient.ReferencedPaymentNonexistence calldata _nonPayment,
        uint64 _redemptionRequestId
    )
        external
    {
        RedemptionRequest storage request = getRedemptionRequest(_state, _redemptionRequestId);
        // check non-payment proof
        require(_nonPayment.paymentReference == PaymentReference.redemption(_redemptionRequestId) &&
            _nonPayment.destinationAddress == request.redeemerUnderlyingAddressHash &&
            _nonPayment.amount == request.underlyingValueUBA - request.underlyingFeeUBA,
            "redemption non-payment mismatch");
        require(_nonPayment.firstOverflowBlock > request.lastUnderlyingBlock && 
            _nonPayment.firstOverflowBlockTimestamp > request.lastUnderlyingTimestamp, 
            "redemption default too early");
        require(_nonPayment.firstCheckedBlock <= request.firstUnderlyingBlock,
            "redemption request too old");
        // we allow only redeemers to trigger redemption failures, since they may want
        // to do it at some particular time
        require(msg.sender == request.redeemer, "only redeemer");
        // pay redeemer in native currency
        uint256 paidAmountWei = _collateralAmountForRedemption(_state, request.agentVault, request.valueAMG);
        IAgentVault(request.agentVault).liquidate(request.redeemer, paidAmountWei);
        // release remaining agent collateral
        Agents.endRedeemingAssets(_state, request.agentVault, request.valueAMG);
        // underlying backing collateral was removed from mintedAMG accounting at redemption request
        // now we add it to free balance since it wasn't paid to the redeemer
        uint256 liquidatedUBA = Conversion.convertAmgToUBA(_state.settings, request.valueAMG);
        UnderlyingFreeBalance.increaseFreeBalance(_state, request.agentVault, liquidatedUBA);
        // send events
        emit AMEvents.RedemptionFailed(request.agentVault, request.redeemer, 
            paidAmountWei, liquidatedUBA, _redemptionRequestId);
        // delete redemption request at end when we don't need data any more
        delete _state.redemptionRequests[_redemptionRequestId];
    }
    
    function _collateralAmountForRedemption(
        AssetManagerState.State storage _state,
        address _agentVault,
        uint64 _requestValueAMG
    )
        internal view
        returns (uint256)
    {
        Agents.Agent storage agent = Agents.getAgent(_state, _agentVault);
        AgentCollateral.Data memory collateralData = AgentCollateral.currentData(_state, _agentVault);
        // paid amount is  min(flr_amount * (1 + extra), total collateral share for the amount)
        uint256 amountWei = Conversion.convertAmgToNATWei(_requestValueAMG, collateralData.amgToNATWeiPrice)
            .mulBips(_state.settings.redemptionFailureFactorBIPS);
        uint256 maxAmountWei = collateralData.collateralShare(agent, _requestValueAMG);
        return amountWei <= maxAmountWei ? amountWei : maxAmountWei;
    }

    function redemptionPaymentBlocked(
        AssetManagerState.State storage _state,
        uint64 _redemptionRequestId
    )
        external
    {
        // blocking proof checked in AssetManager
        RedemptionRequest storage request = getRedemptionRequest(_state, _redemptionRequestId);
        // we allow only agent to trigger blocked payment, since they may want
        // to do it at some particular time
        Agents.requireAgentVaultOwner(request.agentVault);
        // the agent may keep all the underlying backing and redeemer gets nothing
        // underlying backing collateral was removed from mintedAMG accounting at redemption request
        // now we add it to free balance since it couldn't be paid to the redeemer
        Agents.endRedeemingAssets(_state, request.agentVault, request.valueAMG);
        uint256 liquidatedUBA = Conversion.convertAmgToUBA(_state.settings, request.valueAMG);
        UnderlyingFreeBalance.increaseFreeBalance(_state, request.agentVault, liquidatedUBA);
        // notify
        emit AMEvents.RedemptionBlocked(request.agentVault, request.redeemer, liquidatedUBA, _redemptionRequestId);
        // delete redemption request at end when we don't need data any more
        delete _state.redemptionRequests[_redemptionRequestId];
    }
    
    function selfClose(
        AssetManagerState.State storage _state,
        address _agentVault,
        uint256 _amountUBA
    ) 
        external 
        returns (uint256 _closedUBA)
    {
        Agents.requireAgentVaultOwner(_agentVault);
        require(_amountUBA != 0, "self close of 0");
        uint64 amountAMG = Conversion.convertUBAToAmg(_state.settings, _amountUBA);
        (, _closedUBA) = _selfCloseOrLiquidate(_state, _agentVault, amountAMG);
        // send event
        emit AMEvents.SelfClose(_agentVault, _closedUBA);
    }

    // only use by Liquidation.liquidate
    function liquidate(
        AssetManagerState.State storage _state,
        address _liquidator,
        address _agentVault,
        uint64 _amountAMG
    ) 
        internal 
        returns (uint64 _liquidatedAMG)
    {
        require(_amountAMG != 0, "liquidation of 0");
        uint256 liquidatedUBA;
        (_liquidatedAMG, liquidatedUBA) = _selfCloseOrLiquidate(_state, _agentVault, _amountAMG);
        // send event
        emit AMEvents.LiquidationPerformed(_agentVault, _liquidator, liquidatedUBA);
    }

    function _selfCloseOrLiquidate(
        AssetManagerState.State storage _state,
        address _agentVault,
        uint64 _amountAMG
    )
        private
        returns (uint64 _valueAMG, uint256 _valueUBA)
    {
        // dust first
        Agents.Agent storage agent = Agents.getAgent(_state, _agentVault);
        _valueAMG = SafeMath64.min64(_amountAMG, agent.dustAMG);
        Agents.decreaseDust(_state, _agentVault, _valueAMG);
        // redemption tickets
        uint256 maxRedeemedTickets = _state.settings.maxRedeemedTickets;
        for (uint256 i = 0; i < maxRedeemedTickets && _valueAMG < _amountAMG; i++) {
            // each loop, firstTicketId will change since we delete the first ticket
            uint64 ticketId = _state.redemptionQueue.agents[_agentVault].firstTicketId;
            if (ticketId == 0) {
                break;  // no more tickets for this agent
            }
            RedemptionQueue.Ticket storage ticket = _state.redemptionQueue.getTicket(ticketId);
            uint64 ticketValueAMG = SafeMath64.min64(_amountAMG - _valueAMG, ticket.valueAMG);
            // only remove from tickets and add to total, do everything else after the loop
            _removeFromTicket(_state, ticketId, ticketValueAMG);
            _valueAMG += ticketValueAMG;
        }
        // self-close or liquidation is one step, so we can release minted assets without redeeming step
        Agents.releaseMintedAssets(_state, _agentVault, _valueAMG);
        // all the redeemed amount is added to free balance
        _valueUBA = Conversion.convertAmgToUBA(_state.settings, _valueAMG);
        UnderlyingFreeBalance.increaseFreeBalance(_state, _agentVault, _valueUBA);
    }
    
    function _removeFromTicket(
        AssetManagerState.State storage _state,
        uint64 _redemptionTicketId,
        uint64 _redeemedAMG
    ) 
        private
    {
        RedemptionQueue.Ticket storage ticket = _state.redemptionQueue.getTicket(_redemptionTicketId);
        uint64 remainingAMG = ticket.valueAMG - _redeemedAMG;
        if (remainingAMG == 0) {
            _state.redemptionQueue.deleteRedemptionTicket(_redemptionTicketId);
        } else if (remainingAMG < _state.settings.lotSizeAMG) {   // dust created
            Agents.increaseDust(_state, ticket.agentVault, remainingAMG);
            _state.redemptionQueue.deleteRedemptionTicket(_redemptionTicketId);
        } else {
            ticket.valueAMG = remainingAMG;
        }
    }

    function _lastPaymentBlock(AssetManagerState.State storage _state)
        private view
        returns (uint64 _lastUnderlyingBlock, uint64 _lastUnderlyingTimestamp)
    {
        // timeshift amortizes for the time that passed from the last underlying block update
        uint64 timeshift = 
            SafeCast.toUint64(block.timestamp) - _state.currentUnderlyingBlockUpdatedAt;
        _lastUnderlyingBlock =
            _state.currentUnderlyingBlock + _state.settings.underlyingBlocksForPayment;
        _lastUnderlyingTimestamp = 
            _state.currentUnderlyingBlockTimestamp + timeshift + _state.settings.underlyingSecondsForPayment;
    }
}
