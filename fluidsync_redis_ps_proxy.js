function redisProxy(communicatorHost, redisProxyName, onConnect)
{   
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

    this.redisSocket = io(communicatorHost);

    this.commandId = 1;

    this.commandsRegistry = new Map();

    this.subscriptionsRegistry = 
    {
        channels: new Map(),
        patterns: new Map()
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
    
            if(this.onEvent)
            {
                this.onEvent(payload);
            }
        });
        
        this.redisSocket.emit('subscribe', this.feedbackChannel);
        this.redisSocket.emit('subscribe', this.eventChannel);

        this.resubscribeAll();

        if(onConnect)
        {
            onConnect(this);
        }
    });

    return this;
}

//

redisProxy.prototype.heartBeatPeriod = 5 * 1000; // 5 min

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

redisProxy.prototype.registerTokens = function(entries, map)
{
    if(entries === undefined)
    {
        return entries;
    }

    let stableEntries = [];

    for(let i = 0; i < entries.length; ++i)
    {
        let token = entries[i];

        if(typeof token === 'string')
        {
            if(token.length > 0)
            {
                map.set(token, true);

                stableEntries.push(token);
            }            
        }
    }

    return stableEntries;
}

redisProxy.prototype.unregisterTokens = function(entries, map)
{
    let stableEntries = [];

    if((entries === undefined) || (entries.length === 0))
    {
        // unsubscribe from all channels

        map.forEach((v, key) => {
            stableEntries.push(key);
        });

        map.clear();
    }
    else
    {
        for(let i = 0; i < entries.length; ++i)
        {
            let token = entries[i];

            if(typeof token === 'string')
            {
                if(token.length > 0)
                {
                    map.delete(token);

                    stableEntries.push(token);        
                }    
            }
        }        
    }

    return stableEntries;
}

redisProxy.prototype.resubscribeAll = function()
{
    let channels = this.subscriptionsRegistry.channels;
    let patterns = this.subscriptionsRegistry.patterns;

    let channelsEntries = [];
    let patternsEntries = [];

    channels.forEach((v, key) => {
        channelsEntries.push(key);
    });

    patterns.forEach((v, key) => {
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
    if(typeof commandName !== 'string')
    {
        return;
    }

    ++this.commandId;

    let id = this.commandId;

    if(onResult)
    {
        this.commandsRegistry.set(id, onResult);
    }

    let command = commandName.toUpperCase();
    
    let commandPayload = 
    {
        feedbackChannel: this.feedbackChannel, 
        id: id, 
        command: command, 
        args: commandArgs
    };

    if(this.pubsubCommands[command])
    {
        commandPayload.eventChannel = this.eventChannel;
    }

    let subscribeHandler = this.subscribeCommands[command];
    let unsubscribeHandler = this.unsubscribeCommands[command];

    if(subscribeHandler)
    {
        commandPayload.args = subscribeHandler(commandArgs);

        this.runHeartBeat();
    }
    else if(unsubscribeHandler)
    {
        commandPayload.args = unsubscribeHandler(commandArgs);

        this.checkHeartBeat();
    }

    this.redisSocket.emit('publish', 
        {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});    
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
        }                
    }   
}

redisProxy.prototype.checkHeartBeat = function()
{
    // set inactive if no subscriptions

    if((this.subscriptionsRegistry.channels.size === 0) && (this.subscriptionsRegistry.patterns.size === 0))
    {
        if(this.heartBeat)
        {
            clearInterval(this.heartBeatIntervalId);

            this.heartBeat = false;    
        }
    }
}

redisProxy.prototype.onHeartBeat = function()
{
    let commandPayload = 
    {
        eventChannel: this.eventChannel,                
        command: 'heartbeat'
    };
    
    this.redisSocket.emit('publish', 
        {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});    
}
