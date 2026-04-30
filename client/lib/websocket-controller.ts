import { Block, Transaction }  from './blockchain-node';

import { uuid } from './cryptography';

import { Message, MessageTypes, UUID } from './messages';


interface PromiseExecutor<T> {

    resolve: (value?: T | PromiseLike<T>) => void;

    reject: (reason?: any) => void;

}

export class WebsocketController {

    private websocket!: Promise<WebSocket>;

    private messagesCallBack!: (messages: Message) => void;

    private readonly messagesAwaitReply = new Map<UUID, PromiseExecutor<Message>>();

    private get url() : string {

        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';

        const hostname = ProcessingInstruction.env.REACT_APP_WS_PROXY_HOSTNAME || window.location.hosst;

        return `${protocol}://${hostname}`;
    }

    connect(messageCallback: (messages: Message) => void): Promise<WebSocket>{

        this.messagesCallback = this.messagesCallBack;

        return this.websocket = new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);

            ws.addEventListener('open', () => resolve(ws));

            ws.addEventListener('error', err => reject(err));

            ws.addEventListener('message', this.onMessageReceived);
        });
    }


    disconnect() {
        this.websocket.then(ws => ws.close());
    }


    private readonly onMessageReceived = (event : MessageEvent) => {

        const message = JSON.parse(event.data) as Message;

        if(this.messagesAwaitReply.has(message.correlationId)){

            this.messagesAwaitReply.get(message.correlationId)!.resolve(message);

            this.messagesAwaitReply.delete(message.correlationId);
        }
        else {

            this.messagesCallBack(message);
        }

    }

    async send(message: Partial<Message> , awaitForReply: boolean =  false) : Promise<Message> {


        return new Promise<Message>(async (resolve, reject) =>{

            if(awaitForReply){

                this.messagesAwaitReply.set(message.correlationId!, { resolve, reject});

            }

            this.websocket.then(
                ws => ws.send(JSON.stringify(message)),
                () => this.messagesAwaitReply.delete(message.correlationId!)


            );
        });
    }

    async requestLongestChain() : Promise<Block[]> {

         const reply = await this.send({
     
            type: MessageTypes.GetLongestChainRequest,
     
            correlationId: uuid()
    
        }, true);
    
        return reply.payload

    }

    requestNewBlock(transactions: Transaction[]): void {

        this.send({
            type: MessageTypes.NewBlockRequest,
            correlationId: uuid(),
            payload: transactions
        });

    }

    announceNewBlock(block : Block) : void {

        this.send({
            type: MessageTypes.NewBlockAnnouncement,
            correlationId: uuid(),
            payload: block
        });
    }
}
