function redisProxy(communicatorHost, onConnect)
{
    this.redisSocket = io(communicatorHost);

    this.commandId = 1;

    this.registry = {};

    this.redisSocket.on('connect', () => {

        this.redisSocket.emit('subscribe', 'redis-ret');

        if(onConnect)
        {
            onConnect(this.redisSocket);
        }
    });

    this.redisSocket.on('redis-ret', (message) => {
        
        let payload = message.payload;

        let index = 'cmd' + payload.id;

        let f = this.registry[index];

        if(f)
        {
            f(payload.error, payload.reply);

            delete this.registry[index];
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

    this.redisSocket.emit('publish', {channel: 'redis-command', from: 'anon', payload: 
        {id: this.commandId, command: commandName, args: commandArgs}});
}