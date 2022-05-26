import BN from "bn.js";
import { Logger } from "ethers/lib/utils";
import {
    AgentAvailable, AvailableAgentExited, CollateralReservationDeleted, CollateralReserved, MintingExecuted, MintingPaymentDefault,
    RedemptionDefault, RedemptionFinished, RedemptionPaymentBlocked, RedemptionPaymentFailed, RedemptionPerformed, RedemptionRequested, SelfClose
} from "../../../typechain-truffle/AssetManager";
import { EvmEvent } from "../../utils/events";
import { BN_ZERO, formatBN, sumBN, toBN } from "../../utils/helpers";
import { ILogger } from "../../utils/LogFile";
import { FuzzingState } from "./FuzzingState";
import { FuzzingStateComparator } from "./FuzzingStateComparator";
import { EvmEventArgs } from "./WrappedEvents";

// status as returned from getAgentInfo
export enum AgentStatus {
    NORMAL = 0,             // agent is operating normally
    CCB = 1,                // agent in collateral call band
    LIQUIDATION = 2,        // liquidation due to collateral ratio - ends when agent is healthy
    FULL_LIQUIDATION = 3,   // illegal payment liquidation - always liquidates all and then agent must close vault
    DESTROYING = 4,         // agent announced destroy, cannot mint again; all existing mintings have been redeemed before
}

export interface CollateralReservation {
    id: number;
    agentVault: string;
    minter: string;
    valueUBA: BN;
    feeUBA: BN;
    lastUnderlyingBlock: BN;
    lastUnderlyingTimestamp: BN;
    paymentAddress: string;
    paymentReference: string;
}

export interface RedemptionTicket {
    id: number;
    agentVault: string;
    amountUBA: BN;
}

export interface RedemptionRequest {
    id: number;
    agentVault: string;
    valueUBA: BN;
    feeUBA: BN;
    lastUnderlyingBlock: BN;
    lastUnderlyingTimestamp: BN;
    paymentAddress: string;
    paymentReference: string;
    // stateful part
    collateralReleased: boolean;
    underlyingReleased: boolean;
}

type FreeUnderlyingBalanceChangeType = 'minting' | 'redemption' | 'self-close' | 'topup' | 'withdrawal';

export interface FreeUnderlyingBalanceChange {
    type: FreeUnderlyingBalanceChangeType,
    amountUBA: BN,
}

type ActionLogRecord = {
    text: string;
    event: EvmEvent;
};

export class FuzzingStateAgent {
    constructor(
        public parent: FuzzingState,
        public address: string,
        public owner: string,
        public underlyingAddressString: string,
    ) {
    }

    status: AgentStatus = AgentStatus.NORMAL;
    publiclyAvailable: boolean = false;
    feeBIPS: BN = BN_ZERO;
    agentMinCollateralRatioBIPS: BN = BN_ZERO;
    totalCollateralNATWei: BN = BN_ZERO;
    calculatedDustUBA: BN = BN_ZERO;
    reportedDustUBA: BN = BN_ZERO;
    ccbStartTimestamp: BN = BN_ZERO;                // 0 - not in ccb/liquidation
    liquidationStartTimestamp: BN = BN_ZERO;        // 0 - not in liquidation
    announcedUnderlyingWithdrawalId: BN = BN_ZERO;  // 0 - not announced

    // collections
    collateralReservations: Map<number, CollateralReservation> = new Map();
    redemptionTickets: Map<number, RedemptionTicket> = new Map();
    redemptionRequests: Map<number, RedemptionRequest> = new Map();
    freeUnderlyingBalanceChanges: FreeUnderlyingBalanceChange[] = [];
    
    // log
    actionLog: Array<ActionLogRecord> = [];

    // handlers: agent availability

    handleAgentAvailable(args: EvmEventArgs<AgentAvailable>) {
        this.publiclyAvailable = true;
        this.agentMinCollateralRatioBIPS = toBN(args.agentMinCollateralRatioBIPS);
        this.feeBIPS = toBN(args.feeBIPS);
    }

    handleAvailableAgentExited(args: EvmEventArgs<AvailableAgentExited>) {
        this.publiclyAvailable = false;
    }

    // handlers: minting

    handleCollateralReserved(args: EvmEventArgs<CollateralReserved>) {
        const cr = this.newCollateralReservation(args);
        this.collateralReservations.set(cr.id, cr);
        this.addObjectActionLog("new CollateralReservation", args.$event, cr);
    }

    handleMintingExecuted(args: EvmEventArgs<MintingExecuted>) {
        // update underlying free balance
        this.addFreeUnderlyingBalanceChange(args.$event, 'minting', toBN(args.receivedFeeUBA));
        // create redemption ticket
        const ticket = this.newRedemptionTicket(args);
        this.redemptionTickets.set(ticket.id, ticket);
        this.addObjectActionLog("new RedemptionTicket", args.$event, ticket);
        // delete collateral reservation
        const collateralReservationId = Number(args.collateralReservationId);
        if (collateralReservationId > 0) {  // collateralReservationId == 0 for self-minting
            this.deleteCollateralReservation(args.$event, collateralReservationId);
        }
    }

    handleMintingPaymentDefault(args: EvmEventArgs<MintingPaymentDefault>) {
        this.deleteCollateralReservation(args.$event, Number(args.collateralReservationId));
    }

    handleCollateralReservationDeleted(args: EvmEventArgs<CollateralReservationDeleted>) {
        this.deleteCollateralReservation(args.$event, Number(args.collateralReservationId));
    }

    // handlers: redemption and self-close

    handleRedemptionRequested(args: EvmEventArgs<RedemptionRequested>): void {
        const request = this.newRedemptionRequest(args);
        this.redemptionRequests.set(request.id, request);
        this.closeRedemptionTickets(args.$event, toBN(args.valueUBA));
        this.addObjectActionLog("new RedemptionRequest", args.$event, request);
    }

    handleRedemptionPerformed(args: EvmEventArgs<RedemptionPerformed>): void {
        const request = this.getRedemptionRequest(Number(args.requestId));
        request.collateralReleased = true;
        this.releaseClosedRedemptionRequests(args.$event, request);
    }

    handleRedemptionPaymentFailed(args: EvmEventArgs<RedemptionPaymentFailed>): void {
        // irrelevant to agent
    }

    handleRedemptionPaymentBlocked(args: EvmEventArgs<RedemptionPaymentBlocked>): void {
        const request = this.getRedemptionRequest(Number(args.requestId));
        request.collateralReleased = true;
        this.releaseClosedRedemptionRequests(args.$event, request);
    }

    handleRedemptionDefault(args: EvmEventArgs<RedemptionDefault>): void {
        const request = this.getRedemptionRequest(Number(args.requestId));
        request.collateralReleased = true;
        this.releaseClosedRedemptionRequests(args.$event, request);
    }

    handleRedemptionFinished(args: EvmEventArgs<RedemptionFinished>): void {
        const request = this.getRedemptionRequest(Number(args.requestId));
        request.underlyingReleased = true;
        this.addFreeUnderlyingBalanceChange(args.$event, 'redemption', toBN(args.freedUnderlyingBalanceUBA));
        this.releaseClosedRedemptionRequests(args.$event, request);
    }

    handleSelfClose(args: EvmEventArgs<SelfClose>): void {
        this.addFreeUnderlyingBalanceChange(args.$event, 'self-close', toBN(args.valueUBA));
    }

    // agent state changing

    depositCollateral(value: BN) {
        this.totalCollateralNATWei = this.totalCollateralNATWei.add(value);
    }

    withdrawCollateral(value: BN) {
        this.totalCollateralNATWei = this.totalCollateralNATWei.sub(value);
    }

    newCollateralReservation(args: EvmEventArgs<CollateralReserved>): CollateralReservation {
        return {
            id: Number(args.collateralReservationId),
            agentVault: args.agentVault,
            minter: args.minter,
            valueUBA: toBN(args.valueUBA),
            feeUBA: toBN(args.feeUBA),
            lastUnderlyingBlock: toBN(args.lastUnderlyingBlock),
            lastUnderlyingTimestamp: toBN(args.lastUnderlyingTimestamp),
            paymentAddress: args.paymentAddress,
            paymentReference: args.paymentReference,
        };
    }

    deleteCollateralReservation(event: EvmEvent, crId: number) {
        this.addObjectActionLog("delete CollateralReservation", event, this.collateralReservations.get(crId));
        const deleted = this.collateralReservations.delete(crId);
        assert.isTrue(deleted, `Invalid collateral reservation id ${crId}`);
    }

    newRedemptionTicket(args: EvmEventArgs<MintingExecuted>): RedemptionTicket {
        return {
            id: Number(args.redemptionTicketId),
            agentVault: this.address,
            amountUBA: toBN(args.mintedAmountUBA)
        };
    }
    
    closeRedemptionTickets(event: EvmEvent, amountUBA: BN) {
        const lotSize = this.parent.lotSize();
        const tickets = Array.from(this.redemptionTickets.values());
        tickets.sort((a, b) => a.id - b.id);    // sort by ticketId, so that we close them in correct order
        const amountLots = amountUBA.div(lotSize);
        let remainingLots = amountLots;
        let count = 0;
        for (const ticket of tickets) {
            if (remainingLots.isZero()) break;
            const ticketLots = ticket.amountUBA.div(lotSize);
            const redeemLots = BN.min(remainingLots, ticketLots);
            const redeemUBA = redeemLots.mul(lotSize);
            remainingLots = remainingLots.sub(redeemLots);
            const newTicketAmountUBA = ticket.amountUBA.sub(redeemUBA);
            if (newTicketAmountUBA.lt(lotSize)) {
                this.calculatedDustUBA = this.calculatedDustUBA.add(newTicketAmountUBA);
                this.addActionLog(`delete RedemptionTicket(${ticket.id}): amount=${formatBN(ticket.amountUBA)} created_dust=${formatBN(newTicketAmountUBA)}`, event);
                this.redemptionTickets.delete(ticket.id);
            } else {
                ticket.amountUBA = newTicketAmountUBA;
                this.addActionLog(`partial redeemption RedemptionTicket(${ticket.id}): old_amount=${formatBN(ticket.amountUBA)} new_amount=${formatBN(newTicketAmountUBA)}`, event);
            }
            ++count;
        }
        const redeemedLots = amountLots.sub(remainingLots);
        const remainingUBA = amountUBA.sub(redeemedLots.mul(lotSize));
        this.addActionLog(`redeemed ${count} tickets, ${redeemedLots} lots, remainingUBA=${formatBN(remainingUBA)}, lotSize=${formatBN(lotSize)}`, event);
    }

    newRedemptionRequest(args: EvmEventArgs<RedemptionRequested>): RedemptionRequest {
        return {
            id: Number(args.requestId),
            agentVault: args.agentVault,
            valueUBA: toBN(args.valueUBA),
            feeUBA: toBN(args.feeUBA),
            lastUnderlyingBlock: toBN(args.lastUnderlyingBlock),
            lastUnderlyingTimestamp: toBN(args.lastUnderlyingTimestamp),
            paymentAddress: args.paymentAddress,
            paymentReference: args.paymentReference,
            collateralReleased: false,
            underlyingReleased: false,
        };
    }
    
    getRedemptionRequest(requestId: number) {
        return this.redemptionRequests.get(requestId) ?? assert.fail(`Invalid redemption request id ${requestId}`);
    }

    releaseClosedRedemptionRequests(event: EvmEvent, request: RedemptionRequest) {
        if (request.collateralReleased && request.underlyingReleased) {
            this.redemptionRequests.delete(request.id);
            this.addObjectActionLog("delete RedemptionRequest", event, request);
        }
    }

    addFreeUnderlyingBalanceChange(event: EvmEvent, type: FreeUnderlyingBalanceChangeType, amountUBA: BN) {
        const change: FreeUnderlyingBalanceChange = { type, amountUBA };
        this.freeUnderlyingBalanceChanges.push(change);
        this.addObjectActionLog("new FreeUnderlyingBalanceChange", event, change);
    }

    addObjectActionLog(title: string, event: EvmEvent, object: any) {
        const amount = object.valueUBA ?? object.amountUBA ?? BN_ZERO;
        const fee = object.feeUBA ?? BN_ZERO;
        const text = `${title}: id=${object.id ?? "/"} amount=${formatBN(amount)} fee=${formatBN(fee)}`;
        this.addActionLog(text, event);
    }
    
    addActionLog(text: string, event: EvmEvent) {
        this.actionLog.push({ text, event });
    }

    // totals

    reservedUBA() {
        return sumBN(this.collateralReservations.values(), ticket => ticket.valueUBA);
    }

    mintedUBA() {
        return sumBN(this.redemptionTickets.values(), ticket => ticket.amountUBA).add(this.reportedDustUBA);
    }

    freeUnderlyingBalanceUBA() {
        return sumBN(this.freeUnderlyingBalanceChanges, change => change.amountUBA);
    }

    // checking

    async checkInvariants(checker: FuzzingStateComparator) {
        const agentName = this.parent.eventFormatter.formatAddress(this.address);
        // get actual agent state
        const agentInfo = await this.parent.context.assetManager.getAgentInfo(this.address);
        let problems = 0;
        // reserved
        const reservedUBA = this.reservedUBA();
        problems += checker.checkEquality(`${agentName}.reservedUBA`, agentInfo.reservedUBA, reservedUBA);
        // minted
        const mintedUBA = this.mintedUBA();
        problems += checker.checkEquality(`${agentName}.mintedUBA`, agentInfo.mintedUBA, mintedUBA);
        // free balance
        const freeUnderlyingBalanceUBA = this.freeUnderlyingBalanceUBA();
        problems += checker.checkEquality(`${agentName}.underlyingFreeBalanceUBA`, agentInfo.freeUnderlyingBalanceUBA, freeUnderlyingBalanceUBA);
        // minimum underlying backing (TODO: check that all illegel payments have been challenged already)
        const underlyingBalanceUBA = await this.parent.context.chain.getBalance(this.underlyingAddressString);
        problems += checker.checkNumericDifference(`${agentName}.underlyingBalanceUBA`, underlyingBalanceUBA, 'gte', mintedUBA.add(freeUnderlyingBalanceUBA));
        // dust
        problems += checker.checkEquality(`${agentName}.dustUBA`, this.reportedDustUBA, this.calculatedDustUBA);
        // log
        if (problems > 0) {
            this.writeActionLog(checker.logger);
        }
    }
    
    writeActionLog(logger: ILogger) {
        const agentName = this.parent.eventFormatter.formatAddress(this.address);
        logger.log(`    action log for ${agentName}`);
        for (const log of this.actionLog) {
            const eventInfo = `event=${log.event.event} at ${log.event.blockNumber}/${log.event.logIndex}`;
            logger.log(`        ${log.text}  ${eventInfo}`);
        }
    }
}
