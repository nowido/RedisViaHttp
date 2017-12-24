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

    this.commandsRegistry = {};

    this.subscriptionsRegistry = 
    {
        channels: {},
        patterns: {}
    };

    this.heartBeat = false;
    
    this.redisSocket.on('connect', () => {

        this.feedbackChannel = 'redis-ret-' + this.redisSocket.id;
        this.eventChannel = 'redis-event-' + this.redisSocket.id;
        
        this.resubscribeAll();

        this.redisSocket.on(this.feedbackChannel, (message) => {
        
            let payload = message.payload;
    
            let index = 'cmd' + payload.id;
    
            let f = this.commandsRegistry[index];
    
            if(f)
            {
                f(payload.error, payload.reply);
    
                delete this.commandsRegistry[index];
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

        if(onConnect)
        {
            onConnect(this);
        }
    });

    return this;
}

//

redisProxy.prototype.heartBeatPeriod = 5 * 1000; // 5 min

redisProxy.prototype.channelPrefix = 'rc#';

redisProxy.prototype.channelPrefixLength = redisProxy.prototype.channelPrefix.length;

redisProxy.prototype.patternPrefix = 'rp#';

redisProxy.prototype.patternPrefixLength = redisProxy.prototype.patternPrefix.length;

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
    this.registerTokens(entries, this.subscriptionsRegistry.channels, this.channelPrefix);
}

redisProxy.prototype.registerPatterns = function(entries)
{
    this.registerTokens(entries, this.subscriptionsRegistry.patterns, this.patternPrefix);
}

redisProxy.prototype.unregisterChannels = function(entries)
{
    this.unregisterTokens(entries, this.subscriptionsRegistry.channels, this.channelPrefix);
}

redisProxy.prototype.unregisterPatterns = function(entries)
{
    this.unregisterTokens(entries, this.subscriptionsRegistry.patterns, this.patternPrefix);
}

redisProxy.prototype.registerTokens = function(entries, dictionary, prefix)
{
    if(entries === undefined)
    {
        return;
    }

    for(let i = 0; i < entries.length; ++i)
    {
        dictionary[prefix + entries[i]] = true;
    }
}

redisProxy.prototype.unregisterTokens = function(entries, dictionary, prefix)
{
    if((entries === undefined) || (entries.length === 0))
    {
        dictionary = {};
    }
    else
    {
        for(let i = 0; i < entries.length; ++i)
        {
            delete dictionary[prefix + entries[i]];
        }        
    }
}

redisProxy.prototype.resubscribeAll = function()
{
    let subscriptionsRegistry = this.subscriptionsRegistry;
    
    let channels = subscriptionsRegistry.channels;
    let patterns = subscriptionsRegistry.patterns;

    let prefixedChannelsKeys = Object.keys(channels);
    let prefixedPatternsKeys = Object.keys(patterns);

    let channelsEntries = [];
    let patternsEntries = [];

    for(let i = 0; i < prefixedChannelsKeys.length; ++i)
    {
        let prefixedChannelKey = prefixedChannelsKeys[i];

        channelsEntries.push(prefixedChannelKey.substr(this.channelPrefixLength));
    }

    for(let i = 0; i < prefixedPatternsKeys.length; ++i)
    {
        let prefixedPatternKey = prefixedPatternsKeys[i];

        patternsEntries.push(prefixedPatternKey.substr(this.patternPrefixLength));
    }    

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

    let command = commandName.toUpperCase();

    this.commandId++;

    if(onResult)
    {
        this.commandsRegistry['cmd' + this.commandId] = onResult;
    }

    let commandPayload = 
    {
        feedbackChannel: this.feedbackChannel, 
        id: this.commandId, 
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
        subscribeHandler(commandArgs);

        this.runHeartBeat();
    }
    else if(unsubscribeHandler)
    {
        unsubscribeHandler(commandArgs);

        this.checkHeartBeat();
    }

    this.redisSocket.emit('publish', 
        {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});    
}

redisProxy.prototype.runHeartBeat = function()
{
    // set active if there are subscriptions
    
    let count1 = Object.keys(this.subscriptionsRegistry.channels);
    let count2 = Object.keys(this.subscriptionsRegistry.patterns);

    if((count1 > 0) || (count2 > 0))
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

    let count1 = Object.keys(this.subscriptionsRegistry.channels);
    let count2 = Object.keys(this.subscriptionsRegistry.patterns);

    if((count1 === 0) && (count2 === 0))
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
