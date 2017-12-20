const redis = require('redis');

const io = require('socket.io-client');

const redisHost = '127.0.0.1';
const redisPort = '6379';

const redisConfig = {host: redisHost, port: redisPort};

const redisClient = redis.createClient(redisConfig);

redisClient.on('error', console.log);

const socket = io('https://fluidsync2.herokuapp.com');  

const proxyName = 'unique_instance_name';
const proxyChannel = 'redis-command-' + proxyName;

socket.on('connect', () => {

    socket.emit('subscribe', proxyChannel);    

    console.log('connected to FluidSync');
});

socket.on('reconnect', () => {
    console.log('reconnect to FluidSync ...');        
});    

socket.on('disconnect', () => {
    console.log('disconnected from FluidSync');        
});    

socket.on(proxyChannel, function (data) 
{
    console.log(data);
    
    let message = data.payload;

    if((message === undefined) || (message.feedbackChannel === undefined) || (message.command === undefined))
    {
        return;
    }

    redisClient.send_command(message.command, message.args, (err, reply) => {        

        socket.emit('publish', {channel: message.feedbackChannel, from: proxyName, payload: {id: message.id, error: err, reply: reply}});        
    });
});

console.log('Local Redis connector running...');
