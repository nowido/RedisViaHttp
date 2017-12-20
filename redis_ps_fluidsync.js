const redis = require('redis');

const io = require('socket.io-client');

const redisHost = '127.0.0.1';
const redisPort = '6379';

const redisConfig = {host: redisHost, port: redisPort};

const redisClient = redis.createClient(redisConfig);
const redisSubscribedClient = redisClient.duplicate();

redisClient.on('error', console.log);

const socket = io('https://fluidsync2.herokuapp.com');  

const proxyName = 'unique_instance_name';
const proxyChannel = 'redis-command-' + proxyName;

const pubsubCommands = 
{
    'PSUBSCRIBE': true,
    'PUBLISH': true,
    'PUBSUB': true,
    'PUNSUBSCRIBE': true,
    'SUBSCRIBE': true,
    'UNSUBSCRIBE': true
};

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

function sendReply(message, err, reply)
{
    let feedbackChannel = message.feedbackChannel;

    if(typeof feedbackChannel !== 'string')
    {
        return;
    }

    socket.emit('publish', {channel: feedbackChannel, from: proxyName, payload: {id: message.id, error: err, reply: reply}});            
}

//-----------------------------
// Redis PubSub stuff

var subscriptionsRegistry = 
{
        // dictionary to store sockets subscribed for 'some çhannel'
    channels: {}
};

function registerSubscription(channelId, eventChannelId)
{
    let prefixedChannelId = 'rc#' + channelId;

    let channels = subscriptionsRegistry.channels;

    let entry = channels[prefixedChannelId];

    if(entry === undefined)
    {
        entry = channels[prefixedChannelId] = {};
    }

    entry[eventChannelId] = true;
}

function removeSubscription(channelId, eventChannelId)
{
    let prefixedChannelId = 'rc#' + channelId;

    let channels = subscriptionsRegistry.channels;

    let entry = channels[prefixedChannelId];

    if(entry !== undefined)
    {
        delete entry[eventChannelId];
    }
}

function subscribe(message)
{
    let channels = message.args;

    let eventChannelId = message.eventChannel;

    if(typeof eventChannelId !== 'string')
    {
        return;
    }

    for(let i = 0; i < channels.length; ++i)
    {
        registerSubscription(channels[i], eventChannelId);
    }            

    redisSubscribedClient.send_command('subscribe', channels, (err, reply) => {        

        sendReply(message, err, reply);        
    });    
}

function unsubscribe(message)
{
    let channels = message.args;

    let eventChannelId = message.eventChannel;

    if(typeof eventChannelId !== 'string')
    {
        return;
    }
    
    redisSubscribedClient.send_command('unsubscribe', channels, (err, reply) => {        

        for(let i = 0; i < channels.length; ++i)
        {
            removeSubscription(channels[i], eventChannelId);
        }            
            
        sendReply(message, err, reply);        
    });    
}

function notifySubscribers(channel, message)
{
    let prefixedChannelId = 'rc#' + channel;

    let subscribers = subscriptionsRegistry.channels[prefixedChannelId];    

    if(subscribers === undefined)
    {
        return;
    }

    let eventChannelsIds = Object.keys(subscribers);
    
    let subscribersCount = eventChannelsIds.length;

    for(let i = 0; i < subscribersCount; ++i)
    {
        socket.emit('publish', {channel: eventChannelsIds[i], from: proxyName, payload: message});     
    }
}

redisSubscribedClient.on('message', (channel, message) => {

    notifySubscribers(channel, {event: 'message', channel: channel, message: message});    
});

redisSubscribedClient.on('pmessage', (pattern, channel, message) => {

});

redisSubscribedClient.on('message_buffer', (channel, message) => {

});

redisSubscribedClient.on('pmessage_buffer', (pattern, channel, message) => {

});

redisSubscribedClient.on('subscribe', (channel, count) => {

    notifySubscribers(channel, {event: 'subscribe', channel: channel, count: count});

});

redisSubscribedClient.on('psubscribe', (pattern, count) => {

});

redisSubscribedClient.on('unsubscribe', (channel, count) => {

    notifySubscribers(channel, {event: 'unsubscribe', channel: channel, count: count});
});

redisSubscribedClient.on('punsubscribe', (pattern, count) => {

});

//-----------------------------

socket.on(proxyChannel, function (data) 
{
    console.log(data);
    
    let message = data.payload;

    let command = message.command;

    if((message === undefined) || (command === undefined))
    {
        return;
    }

    command = command.toUpperCase();

    if(pubsubCommands[command])
    {
        if(command === 'SUBSCRIBE')
        {
            subscribe(message);    
        }
        else if(command === 'UNSUBSCRIBE')
        {
            unsubscribe(message);
        }
    }
    else
    {
        redisClient.send_command(command, message.args, (err, reply) => {        

            sendReply(message, err, reply);            
        });    
    }
});

console.log('Local Redis connector running...');