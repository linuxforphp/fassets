import { BaseEvent, ContractWithEventsBase, EventArgsForName, EventNamesFor } from "../../utils/events";
import { IBlockChainEvents, IBlockId, ITransaction } from "../../utils/fasset/ChainInterfaces";
import { multimapAdd, multimapDelete } from "../../utils/helpers";
import { ClearableSubscription, EventEmitter, EventExecutionQueue, QueuedEventEmitter } from "./ScopedEvents";
import { TruffleTransactionInterceptor } from "./TransactionInterceptor";

export interface FilteredHandler {
    filter: Record<string, unknown> | undefined;
    handler: (eventArgs: any) => void;
}

export class TruffleEvents {
    constructor(
        public interceptor: TruffleTransactionInterceptor,
        public eventQueue: EventExecutionQueue,
    ) {
        interceptor.eventHandlers.set('TruffleEventSubscriber', this.handleEvent.bind(this));
    }

    // map 'address:eventName' => filtered handlers
    private handlers = new Map<string, Set<FilteredHandler>>();

    private handleEvent(event: BaseEvent) {
        const key = `${event.address}:${event.event}`;
        const handlers = this.handlers.get(key);
        if (handlers == null)
            return;
        for (const handler of handlers) {
            if (handler.filter == null || this.filterMatches(handler.filter, event.args)) {
                handler.handler(event.args);
            }
        }
    }

    private filterMatches(filter: Record<string, unknown>, args: any) {
        return Object.entries(filter).every(([key, value]) => String(value) === String(args[key]));
    }

    public event<C extends ContractWithEventsBase, N extends EventNamesFor<C>>(contract: C, event: N, filter?: Partial<EventArgsForName<C, N>>) {
        return new QueuedEventEmitter<EventArgsForName<C, N>>(this.eventQueue, handler => {
            const key = `${contract.address}:${event}`;
            const filteredHandler: FilteredHandler = { filter, handler };
            multimapAdd(this.handlers, key, filteredHandler);
            return ClearableSubscription.of(() => multimapDelete(this.handlers, key, filteredHandler));
        });
    }
}

export class UnderlyingChainEvents {
    constructor(
        private events: IBlockChainEvents,
        public eventQueue: EventExecutionQueue,
    ) { }
    
    blockEvent(): EventEmitter<IBlockId> {
        return new QueuedEventEmitter(this.eventQueue, handler => {
            const subscriptionId = this.events.addBlockHandler(handler);
            return ClearableSubscription.of(() => this.events.removeHandler(subscriptionId));
        });
    }
    
    transactionEvent(filter: { [name: string]: string } | null = null): EventEmitter<ITransaction> {
        return new QueuedEventEmitter(this.eventQueue, handler => {
            const subscriptionId = this.events.addTransactionHandler(filter, handler);
            return ClearableSubscription.of(() => this.events.removeHandler(subscriptionId));
        });
    }
}
