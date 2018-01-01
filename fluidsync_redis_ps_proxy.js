// RedisProxy constructor

function RedisProxy(options){

// constructor args must be present:

    if(!options){return null;}

// remote node identifier must be present:

    let remoteNodeName = options.remoteNodeName; 

    if(!remoteNodeName){return null;}

// there is default FluidSync service host, if not specified in args:

    let communicatorHost = options.communicatorHost;
        
    if(!communicatorHost){
        communicatorHost = this.defaultCommunicatorHost;
    }
    
// optional handlers may be specified in args:

    let onConnect = options.onConnect;

    if(onConnect){
        this.onConnect = onConnect;
    }

    let onDisconnect = options.onDisconnect;

    if(onDisconnect){
        this.onDisconnect = onDisconnect;
    }

    let onEvent = options.onEvent;

    if(onEvent){
        this.onEvent = onEvent;
    }
    
    let onRemoteNodeChanged = options.onRemoteNodeChanged;

    if(onRemoteNodeChanged){
        this.onRemoteNodeChanged = onRemoteNodeChanged;
    }
    
    let onPresence = options.onPresence;

    if(onPresence){
        this.onPresence = onPresence;
    }

// RedisProxy instance internal fields:

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

    this.redisSocket = io(communicatorHost);

    this.commandId = 1;

    this.commandsRegistry = new Map();

    this.subscriptionsRegistry = 
    {
        channels: new Set(),
        patterns: new Set()
    };

    this.heartBeat = false;
    
    this.redisSocket.on('connect', () => {

        this.feedbackChannel = 'redis-ret-' + this.redisSocket.id;
        this.eventChannel = 'redis-event-' + this.redisSocket.id;        
                
        this.redisSocket.on(this.feedbackChannel, (message) => {
        
            let payload = message.payload;
    
            let id = payload.id;

            let handler = this.commandsRegistry.get(id);
    
            if(handler)
            {
                handler(payload.error, payload.reply);
    
                this.commandsRegistry.delete(id)                
            }
        });

        this.redisSocket.on(this.eventChannel, (message) => {
        
            let payload = message.payload;

            if(payload && (typeof payload.proxySocketId === 'string'))
            {                
                this.checkPresence(payload.proxySocketId);
            }

            if(this.onEvent){
                this.onEvent(payload, this);
            }
        });
        
        this.redisSocket.on(this.redisPresenceChannel, (message) => {
            
            let payload = message.payload;

            if(payload && (typeof payload.proxySocketId === 'string'))
            {                
                this.checkPresence(payload.proxySocketId);

                if(this.onPresence){
                    this.onPresence(this);
                }    
            }            
        });

        this.redisSocket.emit('subscribe', this.redisPresenceChannel);
        this.redisSocket.emit('subscribe', this.feedbackChannel);
        this.redisSocket.emit('subscribe', this.eventChannel);

        this.resubscribeAll();

        if(this.onConnect){
            this.onConnect(this);
        }

    }); // end on connect

    this.redisSocket.on('disconnect', () => {

        this.deactivateHeartBeat();    

        if(this.onDisconnect){
            this.onDisconnect(this);
        }        
    }); 

    return this;

} // end constructor

// RedisProxy interface methods

RedisProxy.prototype.sendCommand = function(commandName, commandArgs, onResult)
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

RedisProxy.prototype.sendCommandsPack = function(commandsPack, onResult)
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

// RedisProxy internal methods:

RedisProxy.prototype.registerChannels = function(entries)
{
    return this.registerTokens(entries, this.subscriptionsRegistry.channels);
}

RedisProxy.prototype.registerPatterns = function(entries)
{
    return this.registerTokens(entries, this.subscriptionsRegistry.patterns);
}

RedisProxy.prototype.unregisterChannels = function(entries)
{
    return this.unregisterTokens(entries, this.subscriptionsRegistry.channels);
}

RedisProxy.prototype.unregisterPatterns = function(entries)
{
    return this.unregisterTokens(entries, this.subscriptionsRegistry.patterns);
}

RedisProxy.prototype.registerTokens = function(entries, registry)
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

RedisProxy.prototype.unregisterTokens = function(entries, registry)
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

RedisProxy.prototype.resubscribeAll = function()
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

RedisProxy.prototype.runHeartBeat = function()
{
    // set active if there are subscriptions
    
    if((this.subscriptionsRegistry.channels.size > 0) || (this.subscriptionsRegistry.patterns.size > 0))
    {
        if(!this.heartBeat)
        {
            this.heartBeatIntervalId = setInterval(this.onHeartBeat.bind(this), this.heartBeatPeriod);
    
            this.heartBeat = true;

            console.log('heartbeat is now on');
        }                
    }   
}

RedisProxy.prototype.checkHeartBeat = function()
{
    // set inactive if no subscriptions

    if((this.subscriptionsRegistry.channels.size === 0) && (this.subscriptionsRegistry.patterns.size === 0))
    {
        this.deactivateHeartBeat();
    }
}

RedisProxy.prototype.deactivateHeartBeat = function()
{
    if(this.heartBeat)
    {
        clearInterval(this.heartBeatIntervalId);

        this.heartBeat = false;    

        console.log('heartbeat is now off');
    }
}

RedisProxy.prototype.onHeartBeat = function()
{
    this.emitCommand({eventChannel: this.eventChannel, command: 'heartbeat'});
}

RedisProxy.prototype.checkPresence = function(incomingPresenceId)
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

        if(this.onRemoteNodeChanged){
            this.onRemoteNodeChanged(this);    
        }
    }
}

RedisProxy.prototype.emitCommand = function(payload)
{
    this.redisSocket.emit('publish', 
    {
        channel: this.redisCommandsChannel, 
        from: this.redisSocket.id, 
        payload: payload
    });    
}

// RedisProxy constants:

RedisProxy.prototype.defaultCommunicatorHost = 'https://fluidsync2.herokuapp.com';

RedisProxy.prototype.heartBeatPeriod = 1 * 60 * 1000; // 1 min

RedisProxy.prototype.pubsubCommands = 
{
    'PSUBSCRIBE': true,
    'PUNSUBSCRIBE': true,
    'SUBSCRIBE': true,
    'UNSUBSCRIBE': true
};

// end RedisProxy module
        
