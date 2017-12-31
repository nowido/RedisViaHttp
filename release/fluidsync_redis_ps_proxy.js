function redisProxy(options)
{   
    if(!options)
    {
        return null;
    }

    let redisProxyName = options.redisProxyName;

    if(!redisProxyName)
    {
        return null;
    }

    let communicatorHost = options.communicatorHost;
        
    if(!communicatorHost)
    {
        communicatorHost = 'https://fluidsync2.herokuapp.com';
    }

    let onConnect = options.onConnect;
    let onDisconnect = options.onDisconnect;

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
        
    this.redisProxyChannel = 'redis-command-' + redisProxyName;
    
    this.redisPresenceChannel = 'redis-present-' + redisProxyName;

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
        
            if(this.onEvent)
            {
                this.onEvent(message.payload);
            }
        });
        
        this.redisSocket.on(this.redisPresenceChannel, (message) => {
            
            let payload = message.payload;

            let presenceId = this.lastPresenceId;

            if(presenceId === undefined)
            {
                this.lastPresenceId = payload.proxySocketId;
            }
            else if(presenceId !== payload.proxySocketId)
            {
                this.resubscribeAll();
                
                this.lastPresenceId = payload.proxySocketId;
            }
            
            if(this.onPresence)
            {
                this.onPresence(payload);
            }
        });

        this.redisSocket.emit('subscribe', this.redisPresenceChannel);
        this.redisSocket.emit('subscribe', this.feedbackChannel);
        this.redisSocket.emit('subscribe', this.eventChannel);

        this.resubscribeAll();

        if(onConnect)
        {
            onConnect(this);
        }
    });

    this.redisSocket.on('disconnect', () => {

        this.deactivateHeartBeat();    

        if(onDisconnect)
        {
            onDisconnect(this);
        }        
    });

    return this;
}

//

redisProxy.prototype.heartBeatPeriod = 5 * 60 * 1000; // 5 min

//

redisProxy.prototype.pubsubCommands = 
{
    'PSUBSCRIBE': true,
    'PUNSUBSCRIBE': true,
    'SUBSCRIBE': true,
    'UNSUBSCRIBE': true
};

redisProxy.prototype.registerChannels = function(entries)
{
    return this.registerTokens(entries, this.subscriptionsRegistry.channels);
}

redisProxy.prototype.registerPatterns = function(entries)
{
    return this.registerTokens(entries, this.subscriptionsRegistry.patterns);
}

redisProxy.prototype.unregisterChannels = function(entries)
{
    return this.unregisterTokens(entries, this.subscriptionsRegistry.channels);
}

redisProxy.prototype.unregisterPatterns = function(entries)
{
    return this.unregisterTokens(entries, this.subscriptionsRegistry.patterns);
}

redisProxy.prototype.registerTokens = function(entries, registry)
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

redisProxy.prototype.unregisterTokens = function(entries, registry)
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

redisProxy.prototype.resubscribeAll = function()
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
    
        this.redisSocket.emit('publish', 
            {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});        
    }

    if(patternsEntries.length > 0)
    {
        this.commandId++;
    
        commandPayload.id = this.commandId;
        commandPayload.command = 'psubscribe';
        commandPayload.args = patternsEntries;
    
        this.redisSocket.emit('publish', 
            {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});                
    }

    this.runHeartBeat();
}

redisProxy.prototype.sendCommand = function(commandName, commandArgs, onResult)
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
        
        this.redisSocket.emit('publish', {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});    
    
    } // end if command is non-empty string
}

redisProxy.prototype.sendCommandsPack = function(commandsPack, onResult)
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
        
        this.redisSocket.emit('publish', {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});
    }
}

redisProxy.prototype.runHeartBeat = function()
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

redisProxy.prototype.checkHeartBeat = function()
{
    // set inactive if no subscriptions

    if((this.subscriptionsRegistry.channels.size === 0) && (this.subscriptionsRegistry.patterns.size === 0))
    {
        this.deactivateHeartBeat();
    }
}

redisProxy.prototype.deactivateHeartBeat = function()
{
    if(this.heartBeat)
    {
        clearInterval(this.heartBeatIntervalId);

        this.heartBeat = false;    

        //console.log('heartbeat is now off');
    }
}

redisProxy.prototype.onHeartBeat = function()
{
    let commandPayload = 
    {
        eventChannel: this.eventChannel,                
        command: 'heartbeat'
    };
    
    this.redisSocket.emit('publish', {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});    
}
