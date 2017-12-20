function redisProxy(communicatorHost, redisProxyName, onConnect)
{    
    this.redisProxyChannel = 'redis-command-' + redisProxyName;

    this.redisSocket = io(communicatorHost);

    this.commandId = 1;

    this.registry = {};

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
    'PUBLISH': true,
    'PUBSUB': true,
    'PUNSUBSCRIBE': true,
    'SUBSCRIBE': true,
    'UNSUBSCRIBE': true
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
    }

    this.redisSocket.emit('publish', {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: commandPayload});    
}