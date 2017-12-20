function redisProxy(communicatorHost, redisProxyName, onConnect)
{    
    this.redisProxyChannel = 'redis-command-' + redisProxyName;

    this.redisSocket = io(communicatorHost);

    this.commandId = 1;

    this.registry = {};

    this.redisSocket.on('connect', () => {

        this.feedbackChannel = 'redis-ret-' + this.redisSocket.id;
        
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
            
        this.redisSocket.emit('subscribe', this.feedbackChannel);

        if(onConnect)
        {
            onConnect(this);
        }
    });

    return this;
}

redisProxy.prototype.sendCommand = function(commandName, commandArgs, onResult)
{    
    this.commandId++;

    if(onResult)
    {
        this.registry['cmd' + this.commandId] = onResult;
    }

    this.redisSocket.emit('publish', {channel: this.redisProxyChannel, from: this.redisSocket.id, payload: 
        {feedbackChannel: this.feedbackChannel, id: this.commandId, command: commandName, args: commandArgs}});
}
