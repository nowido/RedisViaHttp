const redis = require('redis');
const url = require('url');
const http = require('http');
const socketServer = require('socket.io');

const redisHost = '127.0.0.1';
const redisPort = '6379';

const redisConfig = {host: redisHost, port: redisPort};

const redisClient = redis.createClient(redisConfig);

redisClient.on('error', console.log);

console.log('Local Redis connector running...');

const io = new socketServer();
 
io.on('connection', function (socket) 
{
    socket.on('command', function (data) 
    {
        console.log(data);

        redisClient.send_command(data.command, data.args, (err, reply) => {
            socket.emit('ret', {id: data.id, error: err, reply: reply});
        });
    });
});

io.listen(3000);
