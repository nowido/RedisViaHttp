const WebSocket = require('ws');

module.exports = class FluidSyncClient
{
    constructor(options)
    {
        if(!options)
        {
            options = {};
        }
    
        let serverUrl = options.serverUrl;
    
        if(serverUrl)
        {
            this.serverUrl = serverUrl;
        }
        else
        {
            // by default
            this.serverUrl = 'wss://fluidsync2.herokuapp.com';
        }
    
        this.clientHandlers = new Map();
    
        this.WATCHDOG_PERIOD = 20 * 1000; // 20 sec
    
        this.appLayerPingMessage = 'fluidsync-ping';
        this.appLayerPongMessage = 'fluidsync-pong';
            
        let eventTypes = ['open', 'close', 'error', 'message', 'pong'];
        let handlerKeys = ['onOpen', 'onClose', 'onError', 'onMessage', 'onPong'];
    
        eventTypes.forEach((et, i) => {
    
            let handler = options[handlerKeys[i]];
    
            if(handler)
            {
                this.addEventListener(et, handler);    
            }
        })
        
        this.openHandlerBound = this.onOpen.bind(this);
        this.closeHandlerBound = this.onClose.bind(this);
        this.errorHandlerBound = this.onError.bind(this);
        this.messageHandlerBound = this.onMessage.bind(this);
        this.onWatchdogBound = this.onWatchdog.bind(this);
    
        this.connect();
    
        return this;        
    }

    connect()
    {
        this.socket = new WebSocket(this.serverUrl);
    
        if(this.socket)
        {
            this.disconnected = false;
    
            this.addHandlers();            
    
            this.startWatchdog();
        }                        
    }
    
    onOpen(e)
    {
        this.id = this.generateUniqueId();
    
        let handler = this.clientHandlers.get('open');
    
        if(handler)
        {
            handler(this);
        }            
    }
    
    onClose(e)
    {
        this.disconnected = true;
    
        this.removeHandlers();
    
        this.socket = undefined;
    
        let handler = this.clientHandlers.get('close');
    
        if(handler)
        {
            handler(this, e.code, e.reason);
        }
    }
    
    onError()
    {
        let handler = this.clientHandlers.get('error');
    
        if(handler)
        {
            handler(this);
        }                        
    }
    
    onMessage(e)
    {
        let jsonData = e.data;
    
        let handlers = this.clientHandlers;
    
        if(jsonData === this.appLayerPongMessage)
        {
            let pongHandler = handlers.get('pong');
    
            if(pongHandler)
            {
                pongHandler(this);
            }
    
            return;
        }
        
        let handler = handlers.get('message');
        
        if(handler)
        {
            handler(this, jsonData);
        }
        else
        {
            try
            {
                let messageObject = JSON.parse(jsonData);
    
                let channel = messageObject.channel;
    
                if((typeof channel === 'string') && (channel.length > 0))
                {
                    let channelHandler = handlers.get(channel);
    
                    if(channelHandler)
                    {
                        channelHandler(this, {
                            channel: channel, 
                            from: messageObject.from, 
                            payload: messageObject.payload
                        });
                    }
                }
            }
            catch(err)
            {}
        }                                           
    }
        
    startWatchdog()
    {
        let watchdog = this.watchdogId;
    
        if(watchdog === undefined)
        {
            this.watchdogId = setInterval(this.onWatchdogBound, this.WATCHDOG_PERIOD);
        }            
    }
    
    onWatchdog()
    {
        if(this.disconnected)
        {
            this.connect();
        }
        else
        {
            let socket = this.socket;
            
            if(socket && (socket.readyState === 1))
            {
                socket.send(this.appLayerPingMessage);
            }
        }
    }
    
    addHandlers()
    {
        let socket = this.socket;
    
        if(socket)
        {
            socket.addEventListener('open', this.openHandlerBound);
            socket.addEventListener('close', this.closeHandlerBound);
            socket.addEventListener('error', this.errorHandlerBound);
            socket.addEventListener('message', this.messageHandlerBound);            
        }
    }
    
    removeHandlers()
    {
        let socket = this.socket;
    
        if(socket)
        {
            socket.removeEventListener('open', this.openHandlerBound);
            socket.removeEventListener('close', this.closeHandlerBound);
            socket.removeEventListener('error', this.errorHandlerBound);
            socket.removeEventListener('message', this.messageHandlerBound);            
        }
    }
    
    generateUniqueId()
    {
        let uniqueId = '';
    
        const alphabet = '0123456789ABCDEF';
    
        const length = 16;
    
        for(let i = 0; i < length; ++i)
        {
            let digitIndex = Math.floor(Math.random() * 16);
    
            uniqueId += alphabet.charAt(digitIndex);
        }
    
        return uniqueId;
    }
    
    addEventListener(eventType, listener)
    {
        if(listener && (typeof eventType === 'string') && (eventType.length > 0))
        {
            this.clientHandlers.set(eventType, listener);    
        }            
    }
    
    removeEventListener(eventType, listener)
    {
        if(listener && (typeof eventType === 'string') && (eventType.length > 0))
        {
            this.clientHandlers.delete(eventType);    
        }            
    }
    
    subscribe(channel)
    {
        let socket = this.socket;
    
        if(socket && (socket.readyState === 1) && (typeof channel === 'string') && (channel.length > 0))
        {
            let message = 
            {
                action: 'subscribe',
                channel: channel
            };
        
            socket.send(JSON.stringify(message));
        }            
    }
    
    publish(message)
    {
        let socket = this.socket;
    
        if(socket && (socket.readyState === 1) && message)
        {
            let channel = message.channel;
            let payload = message.payload;
    
            if((typeof channel === 'string') && (channel.length > 0) && payload)
            {                    
                let json = JSON.stringify({
                    action: 'publish',
                    channel: channel,
                    from: message.from,
                    payload: payload
                });
                    
                socket.send(json);
            }
        }            
    }
    
    shutdown()
    {
        let watchdog = this.watchdogId;
    
        if(watchdog)
        {
            clearInterval(watchdog);
        }
        
        this.removeHandlers();
        
        let socket = this.socket;
        
        if(socket)
        {                
            socket.close();    
    
            this.disconnected = undefined;
            this.socket = undefined;
        }
    }    
};



