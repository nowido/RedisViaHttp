const FluidSyncClient = require('fluidsync_ws_client');

module.exports = class RedisProxy
{
    constructor(options){    
    
    // constructor args must be present:

        if(!options){return null;}

    // remote node identifier must be present:

        let remoteNodeName = options.remoteNodeName; 

        if(!remoteNodeName){return null;}

    // optional handlers may be specified in args:

        this.eventListeners = new Map();

        this.addEventListener('connect', options.onConnect);
        this.addEventListener('disconnect', options.onDisconnect);
        this.addEventListener('pubsub_event', options.onPubsubEvent);
        this.addEventListener('remote_node_changed', options.onRemoteNodeChanged);
        this.addEventListener('presence', options.onPresence);

    // RedisProxy instance internal fields:

        this.heartBeatPeriod = 1 * 60 * 1000; // 1 min

        this.pubsubCommands = 
        {
            'PSUBSCRIBE': true,
            'PUNSUBSCRIBE': true,
            'SUBSCRIBE': true,
            'UNSUBSCRIBE': true
        };
        
        this.subscribeCommands = 
        {
            'PSUBSCRIBE': this.registerPatterns.bind(this),
            'SUBSCRIBE': this.registerChannels.bind(this)
        };
        
        this.unsubscribeCommands = 
        {
            'PUNSUBSCRIBE': this.unregisterPatterns.bind(this),
            'UNSUBSCRIBE': this.unregisterChannels.bind(this)
        };
            
        this.redisCommandsChannel = 'redis-command-' + remoteNodeName;
        
        this.redisPresenceChannel = 'redis-present-' + remoteNodeName;

        this.lastPresenceId = undefined;

        this.commandId = 1;

        this.commandsRegistry = new Map();

        this.subscriptionsRegistry = 
        {
            channels: new Set(),
            patterns: new Set()
        };

        this.heartBeat = false;        
        
        this.handleOpenBound = this.handleOpen.bind(this);
        this.handleCloseBound = this.handleClose.bind(this);

        this.handleCommandsFeedbackBound = this.handleCommandsFeedback.bind(this);
        this.handlePubsubEventsBound = this.handlePubsubEvents.bind(this);
        this.handlePresenceBound = this.handlePresence.bind(this);

        this.redisSocket = new FluidSyncClient();

        if(this.redisSocket)
        {
            this.redisSocket.addEventListener('open', this.handleOpenBound);
            this.redisSocket.addEventListener('close', this.handleCloseBound);    
        }

        return this;
    }

    addEventListener(event, handler)
    {
        if((typeof handler === 'function') && (typeof event === 'string') && (event.length > 0))
        {
            let entry = this.eventListeners.get(event);
    
            if(entry === undefined)
            {
                this.eventListeners.set(event, new Set([handler]));
            }
            else
            {
                entry.add(handler);
            }
        }
    }
    
    removeEventListener(event, handler)
    {
        if((typeof handler === 'function') && (typeof event === 'string') && (event.length > 0))
        {
            let entry = this.eventListeners.get(event);
    
            if(entry !== undefined)
            {
                entry.delete(handler);
                
                if(entry.size === 0)
                {
                    this.eventListeners.delete(event);    
                }
            }
        }
    }
    
    sendCommand(commandName, commandArgs, onResult)
    {
        if((typeof commandName === 'string') && (commandName.length > 0))
        {
            let command = commandName.toUpperCase();
        
            let commandPayload = 
            {
                feedbackChannel: this.feedbackChannel,         
                command: command
            };
        
            if(this.pubsubCommands[command])
            {
                commandPayload.eventChannel = this.eventChannel;
            }
        
            let subscribeHandler = this.subscribeCommands[command];
            let unsubscribeHandler = this.unsubscribeCommands[command];
        
            if(subscribeHandler)
            {
                let stableEntries = subscribeHandler(commandArgs);
        
                if(stableEntries.length === 0)
                {
                    // cancel subscription
        
                    return;
                }
        
                commandPayload.args = stableEntries;
        
                this.runHeartBeat();
            }
            else if(unsubscribeHandler)
            {
                let stableEntries = unsubscribeHandler(commandArgs);
        
                if(stableEntries.length === 0)
                {
                    // cancel unsubscription
        
                    return;
                }
        
                commandPayload.args = stableEntries;
        
                this.checkHeartBeat();
            }
            else
            {
                commandPayload.args = commandArgs;    
            }        
        
            ++this.commandId;
        
            let id = this.commandId;
        
            commandPayload.id = id;
        
            if(onResult)
            {
                this.commandsRegistry.set(id, onResult);
            }
            
            this.emitCommand(commandPayload);
        
        } // end if command is non-empty string
    }
    
    sendCommandsPack(commandsPack, onResult)
    {
        // commandsPack is an array of commands to be executed as one batch
    
        if(commandsPack)
        {
            let commandPayload = 
            {
                feedbackChannel: this.feedbackChannel,         
                command: 'pxpack',
                pack: commandsPack
            };
    
            ++this.commandId;
        
            let id = this.commandId;
        
            commandPayload.id = id;
        
            if(onResult)
            {
                this.commandsRegistry.set(id, onResult);
            }
            
            this.emitCommand(commandPayload);
        }
    }
    
    registerChannels(entries)
    {
        return this.registerTokens(entries, this.subscriptionsRegistry.channels);
    }
    
    registerPatterns(entries)
    {
        return this.registerTokens(entries, this.subscriptionsRegistry.patterns);
    }
    
    unregisterChannels(entries)
    {
        return this.unregisterTokens(entries, this.subscriptionsRegistry.channels);
    }
    
    unregisterPatterns(entries)
    {
        return this.unregisterTokens(entries, this.subscriptionsRegistry.patterns);
    }
    
    registerTokens(entries, registry)
    {
        let stableEntries = [];
        
        if((entries !== undefined) && (entries.length > 0))
        {
            entries.forEach(token => {
    
                if((typeof token === 'string') && (token.length > 0))
                {
                    registry.add(token);
        
                    stableEntries.push(token);
                }
            });
        }
    
        return stableEntries;
    }
    
    unregisterTokens(entries, registry)
    {
        let stableEntries = [];
    
        if((entries !== undefined) && (entries.length > 0))
        {
            entries.forEach(token => {
    
                if((typeof token === 'string') && (token.length > 0))
                {
                    registry.delete(token);
    
                    stableEntries.push(token);        
                }
            });        
        }
        else
        {
            // unsubscribe from all channels|patterns
    
            registry.forEach(token => {
                
                stableEntries.push(token);
            });
    
            registry.clear();
        }
    
        return stableEntries;
    }
    
    resubscribeAll()
    {
        let channels = this.subscriptionsRegistry.channels;
        let patterns = this.subscriptionsRegistry.patterns;
    
        let channelsEntries = [];
        let patternsEntries = [];
    
        channels.forEach(key => {
    
            channelsEntries.push(key);
        });
    
        patterns.forEach(key => {
    
            patternsEntries.push(key);
        });
    
        let commandPayload = 
        { 
            feedbackChannel: this.feedbackChannel,
            eventChannel: this.eventChannel
        };
    
        if(channelsEntries.length > 0)
        {
            this.commandId++;
        
            commandPayload.id = this.commandId;
            commandPayload.command = 'subscribe';
            commandPayload.args = channelsEntries;
        
            this.emitCommand(commandPayload);
        }
    
        if(patternsEntries.length > 0)
        {
            this.commandId++;
        
            commandPayload.id = this.commandId;
            commandPayload.command = 'psubscribe';
            commandPayload.args = patternsEntries;
        
            this.emitCommand(commandPayload);
        }
    
        this.runHeartBeat();
    }
    
    runHeartBeat()
    {
        // set active if there are subscriptions
        
        if((this.subscriptionsRegistry.channels.size > 0) || (this.subscriptionsRegistry.patterns.size > 0))
        {
            if(!this.heartBeat)
            {
                this.heartBeatIntervalId = setInterval(this.onHeartBeat.bind(this), this.heartBeatPeriod);
        
                this.heartBeat = true;
    
                //console.log('heartbeat is now on');
            }                
        }   
    }
    
    checkHeartBeat()
    {
        // set inactive if no subscriptions
    
        if((this.subscriptionsRegistry.channels.size === 0) && (this.subscriptionsRegistry.patterns.size === 0))
        {
            this.deactivateHeartBeat();
        }
    }
    
    deactivateHeartBeat()
    {
        if(this.heartBeat)
        {
            clearInterval(this.heartBeatIntervalId);
    
            this.heartBeat = false;    
    
            //console.log('heartbeat is now off');
        }
    }
    
    onHeartBeat()
    {
        this.emitCommand({eventChannel: this.eventChannel, command: 'heartbeat'});
    }
    
    checkPresence(incomingPresenceId)
    {
        let presenceId = this.lastPresenceId;
    
        if(presenceId === undefined)
        {
            this.lastPresenceId = incomingPresenceId;
        }
        else if(presenceId !== incomingPresenceId)
        {                
            this.lastPresenceId = incomingPresenceId;
    
            this.resubscribeAll();
    
            this.notifyListenersGeneral('remote_node_changed');
        }
    }
    
    emitCommand(payload)
    {
        this.redisSocket.publish({
            channel: this.redisCommandsChannel, 
            from: this.redisSocket.id, 
            payload: payload
        });    
    }
    
    handleOpen(fluidsync)
    {
        let feedbackChannel = 'redis-ret-' + fluidsync.id;
        let eventChannel = 'redis-event-' + fluidsync.id;
        let redisPresenceChannel = this.redisPresenceChannel;
    
        this.feedbackChannel = feedbackChannel;
        this.eventChannel = eventChannel;        
        
        fluidsync.addEventListener(feedbackChannel, this.handleCommandsFeedbackBound);
        fluidsync.addEventListener(eventChannel, this.handlePubsubEventsBound);
        fluidsync.addEventListener(redisPresenceChannel, this.handlePresenceBound);
        
        fluidsync.subscribe(feedbackChannel);
        fluidsync.subscribe(eventChannel);        
        fluidsync.subscribe(redisPresenceChannel);
    
        this.resubscribeAll();
    
        this.notifyListenersGeneral('connect');
    }
    
    handleClose(fluidsync, code, reason)
    {
        let feedbackChannel = this.feedbackChannel;
    
        if(feedbackChannel)
        {
            fluidsync.removeEventListener(feedbackChannel, this.handleCommandsFeedbackBound);
            this.feedbackChannel = undefined;
        }
    
        let eventChannel = this.eventChannel;
        
        if(eventChannel)
        {
            fluidsync.removeEventListener(eventChannel, this.handlePubsubEventsBound);
            this.eventChannel = undefined;
        }
        
        fluidsync.removeEventListener(this.redisPresenceChannel, this.handlePresenceBound);
        
        this.deactivateHeartBeat();    
    
        this.notifyListenersGeneral('disconnect');
    }
    
    handleCommandsFeedback(fluidsync, message)
    {
        let payload = message.payload;
        
        let id = payload.id;
    
        let handler = this.commandsRegistry.get(id);
    
        if(handler)
        {
            handler(payload.error, payload.reply);
    
            this.commandsRegistry.delete(id)                
        }                
    }
    
    handlePubsubEvents(fluidsync, message)
    {
        let payload = message.payload;
    
        if(payload && (typeof payload.proxySocketId === 'string'))
        {                
            this.checkPresence(payload.proxySocketId);
        }
    
        const eventType = 'pubsub_event';
    
        let listeners = this.eventListeners.get(eventType);
    
        if(listeners){
            listeners.forEach(handler => {handler(eventType, payload, this)});
        }    
    }
    
    handlePresence(fluidsync, message)
    {
        let payload = message.payload;
    
        if(payload && (typeof payload.proxySocketId === 'string'))
        {                
            this.checkPresence(payload.proxySocketId);
    
            this.notifyListenersGeneral('presence');
        }            
    }
    
    notifyListenersGeneral(eventType)
    {
        let listeners = this.eventListeners.get(eventType);
    
        if(listeners){
            listeners.forEach(handler => {handler(eventType, this)});
        }
    }    
};

