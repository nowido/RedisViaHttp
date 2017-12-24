function redisProxy(communicatorHost, redisProxyName, onConnect)
{    
    this.redisProxyChannel = 'redis-command-' + redisProxyName;

    this.redisSocket = io(communicatorHost);

    this.commandId = 1;

    this.registry = {};

    this.heartBeat = false;

    this.heartBeatPeriod = 5 * 60 * 1000; // 5 min

    this.redisSocket.on('connect', () => {

        this.feedbackChannel = 'redis-ret-' + this.redisSocket.id;
        this.eventChannel = 'redis-event-' + this.redisSocket.id;
        
        this.redisSocket.on(this.feedbackChannel, (message) => {
        
            let payload = message.payload;
    
            let index = 'cmd' + payload.id;
    
            let f = this.registry[index];
    
            if(f)
            {
                f(payload.error, payload.reply);
    
                delete this.registry[index];
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

redisProxy.prototype.pubsubCommands = 
{
    'PSUBSCRIBE': true,
    'PUNSUBSCRIBE': true,
    'SUBSCRIBE': true,
    'UNSUBSCRIBE': true
};

redisProxy.prototype.subscribeCommands = 
{
    'PSUBSCRIBE': true,
    'SUBSCRIBE': true
};

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
        this.registry['cmd' + this.commandId] = onResult;
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

        this.checkHeartBeat(command);
    }

    this.redisSocket.emit('publish', 
        {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});    
}

redisProxy.prototype.checkHeartBeat = function(command)
{
    if(this.subscribeCommands[command])
    {
        if(!this.heartBeat)
        {
            this.heartBeatIntervalId = setInterval(this.onHeartBeat.bind(this), this.heartBeatPeriod);

            this.heartBeat = true;
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
