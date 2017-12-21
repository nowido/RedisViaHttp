    // Redis client
const redis = require('redis');

    // to do use config or commandline arg to specify Redis server attributes
const redisHost = '127.0.0.1';
const redisPort = '6379';

const redisConfig = {host: redisHost, port: redisPort};

const redisClient = redis.createClient(redisConfig);
const redisSubscribedClient = redisClient.duplicate();

redisClient.on('error', console.log);

//-----------------------------

    // web sockets client
const io = require('socket.io-client');

    // FluidSync host
    // to do use config or commandline arg... but, honestly, if where are other FluidSync providers?
const fluidsync = io('https://fluidsync2.herokuapp.com');  

    // potential clients must know proxyName to compose command channel
const proxyName = 'unique_instance_name';

const proxyChannel = 'redis-command-' + proxyName;

//-----------------------------
// Redis PubSub stuff
//-----------------------------

    // commands subset for Redis Subscribe mode 
const pubsubCommands = 
{
    'PSUBSCRIBE': true,        
    'PUNSUBSCRIBE': true,
    'SUBSCRIBE': true,
    'UNSUBSCRIBE': true
};

//-----------------------------

const channelPrefix = 'rc#';
const patternPrefix = 'rp#';

var subscriptionsRegistry = 
{
        // dictionary to register remote listeners ('event channels') subscribed for 'some channel'
        // this object is keyed with 'some channels' 
        // and contains objects keyed with 'event channels'
    channels: 
    {
        /*
        {eventChannels} 
        */
    },

        // dictionary to register remote listeners ('event channels') subscribed for 'some pattern'
        // this object is keyed with 'some patterns' 
        // and contains objects keyed with 'event channels'
    patterns: 
    {
        /*
        {eventChannels} 
        */
    },

        // 'reverse dictionary' to speed up registry management
    eventChannels: 
    {
        /*
        {
            timestamp: ...,
            channels: {},
            patterns: {}    
        }
        */
    }    
};

    //
subscriptionsRegistry.addChannel = (channel, eventChannel) =>
{    
    let prefixedChannel = channelPrefix + channel;
    let prefixedEventChannel = channelPrefix + eventChannel;

    let channels = subscriptionsRegistry.channels;

    let entry = channels[prefixedChannel];

    if(entry === undefined)
    {
        entry = channels[prefixedChannel] = {};
    }

    entry[prefixedEventChannel] = true;    

        // add to reverse dictionary
    
    let reverseRegistry = subscriptionsRegistry.eventChannels;

    let reverseEntry = reverseRegistry[prefixedEventChannel];

    if(reverseEntry === undefined)
    {
        reverseEntry = reverseRegistry[prefixedEventChannel] = 
        {
            channels: {},
            patterns: {}                
        };
    }    

    reverseEntry.timestamp = Date.now();

    reverseEntry.channels[prefixedChannel] = true;
};

    //
subscriptionsRegistry.addPattern = (pattern, eventChannel) =>
{    
    let prefixedPattern = patternPrefix + pattern;
    let prefixedEventChannel = channelPrefix + eventChannel;

    let patterns = subscriptionsRegistry.patterns;

    let entry = patterns[prefixedPattern];

    if(entry === undefined)
    {
        entry = patterns[prefixedPattern] = {};
    }

    entry[prefixedEventChannel] = true;    

        // add to reverse dictionary
    
    let reverseRegistry = subscriptionsRegistry.eventChannels;

    let reverseEntry = reverseRegistry[prefixedEventChannel];

    if(reverseEntry === undefined)
    {
        reverseEntry = reverseRegistry[prefixedEventChannel] = 
        {
            channels: {},
            patterns: {}                
        };
    }    

    reverseEntry.timestamp = Date.now();

    reverseEntry.patterns[prefixedPattern] = true;        
};

//-----------------------------

/*
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
*/

//-----------------------------

function subscribeForChannels(message)
{
    let channels = message.args;

    if(channels === undefined)
    {
        return;
    }

    let eventChannel = message.eventChannel;

    if(typeof eventChannel !== 'string')
    {
        return;
    }

        // add channels to registry in presumption that Redis takes them correctly

    let count = channels.length;

    for(let i = 0; i < count; ++i)
    {
        subscriptionsRegistry.addChannel(channels[i], eventChannel);        
    }            

    redisSubscribedClient.send_command('subscribe', channels, (err, reply) => {        

        sendReply(message, err, reply);        
    });    
}

function unsubscribeFromChannels(message)
{
    let channels = message.args;

    if(channels === undefined)
    {
        return;
    }
        
    redisSubscribedClient.send_command('unsubscribe', channels, (err, reply) => {        

        sendReply(message, err, reply);        
    });    

    // we do not clean up subscriptions registry for gone subscriber right now;    
    // let time-license garbage collector do it later
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
        fluidsync.emit('publish', {channel: eventChannelsIds[i], from: proxyName, payload: message});     
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

fluidsync.on('connect', () => {

        // now we will receive commands from remote nodes (through FluidSync)
    fluidsync.emit('subscribe', proxyChannel);    

    console.log('connected to FluidSync');
});

fluidsync.on('reconnect', () => {
    console.log('reconnect to FluidSync ...');        
});    

fluidsync.on('disconnect', () => {
    console.log('disconnected from FluidSync');        
});    

//-----------------------------

fluidsync.on(proxyChannel, function (data) 
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
            subscribeForChannels(message);    
        }
        else if(command === 'UNSUBSCRIBE')
        {
            unsubscribeFromChannels(message);
        }
    }
    else
    {
        redisClient.send_command(command, message.args, (err, reply) => {        

            sendReply(message, err, reply);            
        });    
    }
});

//-----------------------------

function sendReply(message, err, reply)
{
    let feedbackChannel = message.feedbackChannel;

    if(typeof feedbackChannel !== 'string')
    {
        return;
    }

    fluidsync.emit('publish', {channel: feedbackChannel, from: proxyName, payload: {id: message.id, error: err, reply: reply}});            
}

//-----------------------------

console.log('Local Redis connector running...');
