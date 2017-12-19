const redis = require('redis');
const url = require('url');
const http = require('http');
const io = require('socket.io-client');

const redisHost = '127.0.0.1';
const redisPort = '6379';

const redisConfig = {host: redisHost, port: redisPort};

const redisClient = redis.createClient(redisConfig);

redisClient.on('error', console.log);

const httpServer = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end('Hello World\n');
  });
  
const socket = io('https://fluidsync2.herokuapp.com');  

function subscribe(socket, channel)
{
    socket.emit('subscribe', channel);
}
        
socket.on('connect', () => {

    subscribe(socket, 'command');
    console.log('connected to FluidSync');
});

socket.on('reconnect', () => {
    console.log('reconnect to FluidSync ...');        
});    

socket.on('disconnect', () => {
    console.log('disconnected from FluidSync');        
});    

socket.on('command', function (data) 
{
    console.log(data);
    
    let message = data.payload;

    redisClient.send_command(message.command, message.args, (err, reply) => {        
        socket.emit('publish', {channel: 'redis-ret', from: 'redis', payload: {id: message.id, error: err, reply: reply}});
    });
});

console.log('Local Redis connector running...');

httpServer.listen(3000);
