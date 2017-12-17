function redisProxy(host)
{
    this.redisSocket = io(host);

    this.commandId = 1;

    this.registry = {};

    this.redisSocket.on('ret', (data) => {

        let id = data.id;

        let index = 'cmd' + id;

        let f = this.registry[index];

        if(f)
        {
            f(data.error, data.reply);

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

    this.redisSocket.emit('command', {id: this.commandId++, command: commandName, args: commandArgs});
}