    // Redis client
const redis = require('redis');

    // to do use config or commandline arg to specify Redis server attributes
const redisHost = '127.0.0.1';
const redisPort = '6379';

const redisConfig = {host: redisHost, port: redisPort};

const redisClient = redis.createClient(redisConfig);
const redisSubscribedClient = redisClient.duplicate();

redisClient.on('error', console.log);
redisSubscribedClient.on('error', console.log);

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

    // commands subset for Redis Subscriber mode 
const pubsubCommands = 
{
    'PSUBSCRIBE': subscribeForPatterns,        
    'PUNSUBSCRIBE': unsubscribeFromPatterns,
    'SUBSCRIBE': subscribeForChannels,
    'UNSUBSCRIBE': unsubscribeFromChannels
};

//-----------------------------

var subscriptionsRegistry = 
{
        // Map to register remote listeners ('event channels') subscribed for 'some channel'
        // Map is keyed with 'some channels' 
        
    channels:  new Map(), // contains Sets of 'event channels'

        // Map to register remote listeners ('event channels') subscribed for 'some*pattern'
        // Map is keyed with 'some*patterns' 
        
    patterns: new Map(), // contains Sets of 'event channels'

        // reverse Map to speed up registry management
        // reverse Map is keyed with 'event channels'
        // and contains Object with two Sets: 'some channels', and 'some*patterns',
        // so we can remove client subscriptions without iterating all over direct maps

    eventChannels: new Map()
        /*
        {
            timestamp: ...,
            channels: new Set(),
            patterns: new Set()    
        }
        */
};

    //
subscriptionsRegistry.addChannel = (channel, eventChannel) =>
{    
    subscriptionsRegistry.addToReverseDictionary(eventChannel, channel, 'channels');

    return subscriptionsRegistry.addToDirectDictionary(channel, eventChannel, 'channels');        
};

    //
subscriptionsRegistry.addPattern = (pattern, eventChannel) =>
{
    subscriptionsRegistry.addToReverseDictionary(eventChannel, pattern, 'patterns');

    return subscriptionsRegistry.addToDirectDictionary(pattern, eventChannel, 'patterns'); 
};

subscriptionsRegistry.addToDirectDictionary = (token, eventChannel, dictionary) =>
{
    let tokensMap = subscriptionsRegistry[dictionary];

    let eventChannelsForToken = tokensMap.get(token);
    
    if(eventChannelsForToken === undefined)
    {
        tokensMap.set(token, new Set([eventChannel]));    
        
        return 1;
    }
    else
    {
        eventChannelsForToken.add(eventChannel);    

        return eventChannelsForToken.size;
    }        
}

subscriptionsRegistry.addToReverseDictionary = (eventChannel, token, dictionary) => 
{
    let reverseRegistry = subscriptionsRegistry.eventChannels;

    let reverseEntry = reverseRegistry.get(eventChannel);

    if(reverseEntry === undefined)
    {
        reverseEntry = {};

        reverseEntry[dictionary] = new Set([token]);

        if(reverseEntry.channels === undefined)
        {
            reverseEntry.channels = new Set();
        }

        if(reverseEntry.patterns === undefined)
        {
            reverseEntry.patterns = new Set();
        }

        reverseRegistry.set(eventChannel, reverseEntry);
    }    
    else
    {
        reverseEntry[dictionary].add(token);    
    }

    reverseEntry.timestamp = Date.now();
};

subscriptionsRegistry.removeChannel = (channel, eventChannel) =>
{    
    subscriptionsRegistry.removeFromReverseDictionary(eventChannel, channel, 'channels');

    return subscriptionsRegistry.removeFromDirectDictionary(channel, eventChannel, 'channels');
};

subscriptionsRegistry.removePattern = (pattern, eventChannel) =>
{
    subscriptionsRegistry.removeFromReverseDictionary(eventChannel, pattern, 'patterns');

    return subscriptionsRegistry.removeFromDirectDictionary(pattern, eventChannel, 'patterns');
};

subscriptionsRegistry.removeFromDirectDictionary = (token, eventChannel, dictionary) =>
{
    let tokensMap = subscriptionsRegistry[dictionary];

    let eventChannelsForToken = tokensMap.get(token);

    let directEntriesCount = 0;

    if(eventChannelsForToken !== undefined)
    {
        eventChannelsForToken.delete(eventChannel);
        
        directEntriesCount = eventChannelsForToken.size;

        if(directEntriesCount === 0)
        {
            tokensMap.delete(token);   
        }
    }

    return directEntriesCount;
}

subscriptionsRegistry.removeFromReverseDictionary = (eventChannel, token, dictionary) => 
{
    let reverseRegistry = subscriptionsRegistry.eventChannels;

    let reverseEntry = reverseRegistry.get(eventChannel);

    if(reverseEntry !== undefined)
    {
        reverseEntry[dictionary].delete(token);

        if((reverseEntry.channels.size === 0) && (reverseEntry.patterns.size === 0))
        {
            reverseRegistry.delete(eventChannel);
        }
        else
        {
            reverseEntry.timestamp = Date.now();
        }
    }        
};

subscriptionsRegistry.removeTokensSubscription = (eventChannel, dictionary) => 
{
    let tokens = undefined;

    let reverseEntry = subscriptionsRegistry.eventChannels.get(eventChannel);

    if(reverseEntry !== undefined)
    {
        tokens = [];
    
        reverseEntry[dictionary].forEach(token => {
    
            tokens.push(token);

            subscriptionsRegistry.removeFromDirectDictionary(token, eventChannel, dictionary);                        
        });
    
        reverseEntry[dictionary].clear();            
    }
    
    return tokens;
}

subscriptionsRegistry.removeSubscription = (eventChannel) => 
{    
    let entries = {};

    let channels = subscriptionsRegistry.removeTokensSubscription(eventChannel, 'channels');
    let patterns = subscriptionsRegistry.removeTokensSubscription(eventChannel, 'patterns');

    if(channels !== undefined)
    {
        entries.channels = channels;
    }

    if(patterns !== undefined)
    {
        entries.patterns = patterns;
    }

    return entries;
}

//-----------------------------

function subscribeForChannels(message, command)
{
    let eventChannel = message.eventChannel;

    let entries = message.args;
    
    if((typeof eventChannel === 'string') && (eventChannel.length > 0))
    {        
        if(entries && (entries.forEach !== undefined))
        {
            // add entries (channels) to registry in presumption that Redis takes them correctly    

            let stableEntries = [];

            entries.forEach(channel => {

                if((typeof channel === 'string') && (channel.length > 0))
                {
                    stableEntries.push(channel);

                    let subscribersCount = subscriptionsRegistry.addChannel(channel, eventChannel); 
    
                    let wrappedMessage = {event: 'subscribe', channel: channel, count: subscribersCount};
    
                    fluidsync.emit('publish', {channel: eventChannel, from: proxyName, payload: wrappedMessage});                                
                }
            });

            if(stableEntries.length > 0)
            {
                startGarbageCollectorIfNeeded();

                sendReply(message, null, stableEntries);
    
                redisSubscribedClient.send_command(command, stableEntries);     
            }
        }
    }
    else
    {
        // eventChannel is undefined or of incorrect type

        // no anonymous subscribe allowed, because it is shared environment
        
        let err = 
        {
            args: entries, 
            command: command, 
            code: 'ERR', 
            info: 'no anonymous subscribe allowed'
        };

        sendReply(message, err);
    }           
}

function subscribeForPatterns(message, command)
{
    let eventChannel = message.eventChannel;

    let entries = message.args;
    
    if((typeof eventChannel === 'string') && (eventChannel.length > 0))
    {        
        if(entries && (entries.forEach !== undefined))
        {
            // add entries (patterns) to registry in presumption that Redis takes them correctly    

            let stableEntries = [];

            entries.forEach(pattern => {

                if((typeof pattern === 'string') && (pattern.length > 0))
                {
                    stableEntries.push(pattern);

                    let subscribersCount = subscriptionsRegistry.addPattern(pattern, eventChannel); 
    
                    let wrappedMessage = {event: 'psubscribe', pattern: pattern, count: subscribersCount};
    
                    fluidsync.emit('publish', {channel: eventChannel, from: proxyName, payload: wrappedMessage});                                
                }
            });

            if(stableEntries.length > 0)
            {
                startGarbageCollectorIfNeeded();

                sendReply(message, null, stableEntries);
    
                redisSubscribedClient.send_command(command, stableEntries);     
            }
        }
    }
    else
    {
        // eventChannel is undefined or of incorrect type

        // no anonymous psubscribe allowed, because it is shared environment
        
        let err = 
        {
            args: entries, 
            command: command, 
            code: 'ERR', 
            info: 'no anonymous psubscribe allowed'
        };

        sendReply(message, err);
    }           
}

function unsubscribeFromChannels(message, command)
{
    let eventChannel = message.eventChannel;

    let entries = message.args;

    if((typeof eventChannel === 'string') && (eventChannel.length > 0))
    {        
        if(entries && (entries.forEach !== undefined) && (entries.length > 0))
        {
            // add entries (channels) to registry in presumption that Redis takes them correctly    

            let stableEntries = [];

            entries.forEach(channel => {

                if((typeof channel === 'string') && (channel.length > 0))
                {
                    stableEntries.push(channel);

                    let subscribersCount = subscriptionsRegistry.removeChannel(channel, eventChannel); 
    
                    let wrappedMessage = {event: 'unsubscribe', channel: channel, count: subscribersCount};
    
                    fluidsync.emit('publish', {channel: eventChannel, from: proxyName, payload: wrappedMessage});                                
                }
            });

            if(stableEntries.length > 0)
            {
                stopGarbageCollectorIfNeeded();

                sendReply(message, null, stableEntries);
    
                redisSubscribedClient.send_command(command, stableEntries);     
            }
        }
        else 
        {
            // no entries (channels) specified to unsubscribe from

            // so, unsubscribe this client from all channels

            let allChannelsToRemove = subscriptionsRegistry.removeTokensSubscription(eventChannel, 'channels');  

            redisSubscribedClient.send_command(command, allChannelsToRemove);          
        }
    }
    else
    {
        // eventChannel is undefined or of incorrect type

        // no anonymous unsubscribe allowed, because it is shared environment
        
        let err = 
        {
            args: entries, 
            command: command, 
            code: 'ERR', 
            info: 'no anonymous unsubscribe allowed'
        };

        sendReply(message, err);
    }           
}

function unsubscribeFromPatterns(message, command)
{
    let eventChannel = message.eventChannel;

    let entries = message.args;

    if((typeof eventChannel === 'string') && (eventChannel.length > 0))
    {        
        if(entries && (entries.forEach !== undefined) && (entries.length > 0))
        {
            // add entries (patterns) to registry in presumption that Redis takes them correctly    

            let stableEntries = [];

            entries.forEach(pattern => {

                if((typeof pattern === 'string') && (pattern.length > 0))
                {
                    stableEntries.push(pattern);

                    let subscribersCount = subscriptionsRegistry.removeChannel(pattern, eventChannel); 
    
                    let wrappedMessage = {event: 'punsubscribe', pattern: pattern, count: subscribersCount};
    
                    fluidsync.emit('publish', {channel: eventChannel, from: proxyName, payload: wrappedMessage});                                
                }
            });

            if(stableEntries.length > 0)
            {
                stopGarbageCollectorIfNeeded();

                sendReply(message, null, stableEntries);
    
                redisSubscribedClient.send_command(command, stableEntries);     
            }
        }
        else 
        {
            // no entries (patterns) specified to unsubscribe from

            // so, unsubscribe this client from all patterns

            let allPatternsToRemove = subscriptionsRegistry.removeTokensSubscription(eventChannel, 'patterns');  

            redisSubscribedClient.send_command(command, allPatternsToRemove);          
        }
    }
    else
    {
        // eventChannel is undefined or of incorrect type

        // no anonymous punsubscribe allowed, because it is shared environment
        
        let err = 
        {
            args: entries, 
            command: command, 
            code: 'ERR', 
            info: 'no anonymous punsubscribe allowed'
        };

        sendReply(message, err);
    }           
}

function notifySubscribersOnPubsubEvent(token, dictionary, message)
{
    let subscribers = subscriptionsRegistry[dictionary].get(token);    

    if(subscribers !== undefined)
    {
        subscribers.forEach(eventChannel => {

            fluidsync.emit('publish', {channel: eventChannel, from: proxyName, payload: message});      
        });        
    }
}

function removeSubscriptionsFromRedis(entries)
{
    let channels = entries.channels;
    let patterns = entries.patterns;

    if(channels && (channels.length > 0))
    {
        redisSubscribedClient.send_command('unsubscribe', channels);
    }
    
    if(patterns && (patterns.length > 0))
    {
        redisSubscribedClient.send_command('punsubscribe', patterns);
    }    
}

//-----------------------------

redisSubscribedClient.on('message', (channel, message) => 
{
    let wrappedMessage = {event: 'message', channel: channel, message: message};

    notifySubscribersOnPubsubEvent(channel, 'channels', wrappedMessage);
});

redisSubscribedClient.on('pmessage', (pattern, channel, message) => 
{
    let wrappedMessage = {event: 'pmessage', pattern: pattern, channel: channel, message: message};

    notifySubscribersOnPubsubEvent(pattern, 'patterns', wrappedMessage);
});

/*
redisSubscribedClient.on('message_buffer', (channel, message) => 
{
    let wrappedMessage = {event: 'message_buffer', channel: channel, message: message};

    notifySubscribersOnPubsubEvent(channel, 'channels', wrappedMessage);
});

redisSubscribedClient.on('pmessage_buffer', (pattern, channel, message) => 
{
    let wrappedMessage = {event: 'pmessage_buffer', pattern: pattern, channel: channel, message: message};

    notifySubscribersOnPubsubEvent(pattern, 'patterns', wrappedMessage);
});
*/

//-----------------------------

function updateTimeLicense(message)
{
    let eventChannel = message.eventChannel;

    if((typeof eventChannel === 'string') && (eventChannel.length > 0))
    {
        let entry = subscriptionsRegistry.eventChannels.get(eventChannel);

        if(entry !== undefined)
        {
            entry.timestamp = Date.now();
        }
    }
}

//-----------------------------

const GARBAGE_COLLECTOR_PERIOD = 15 * 1000; // 15 min

const TIME_LICENSE_PERIOD = 20 * 1000; // 20 min

var garbageCollectionPresent = false;
var garbageCollectionIntervalId;

function startGarbageCollectorIfNeeded()
{
    if(subscriptionsRegistry.eventChannels.size > 0)
    {
        if(!garbageCollectionPresent)
        {
            garbageCollectionIntervalId = setInterval(onGarbageCollectorTick, GARBAGE_COLLECTOR_PERIOD);
        
            garbageCollectionPresent = true;
        
            console.log('garbage collector is now on');        
        }        
    }
}

function stopGarbageCollectorIfNeeded()
{
    if(subscriptionsRegistry.eventChannels.size === 0)
    {
        if(garbageCollectionPresent)
        {
            clearInterval(garbageCollectionIntervalId);

            garbageCollectionPresent = false;
    
            console.log('garbage collector is now off');    
        }
    }
}

function onGarbageCollectorTick()
{    
    let eventChannelsToRemove = [];

    let timeNow = Date.now();

    subscriptionsRegistry.eventChannels.forEach((entry, eventChannel) => {

        let age = timeNow - entry.timestamp;

        console.log(eventChannel + ': ' + age + ': (of ' + TIME_LICENSE_PERIOD + ')');

        if(age >= TIME_LICENSE_PERIOD)
        {
            eventChannelsToRemove.push(eventChannel);
        }        
    });

    if(eventChannelsToRemove.length > 0)
    {
        eventChannelsToRemove.forEach(eventChannel => {
            
            let entries = subscriptionsRegistry.removeSubscription(eventChannel);

            removeSubscriptionsFromRedis(entries);    
        });        
    }

    stopGarbageCollectorIfNeeded();
}

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

    if(command === 'HEARTBEAT')
    {
        updateTimeLicense(message);

        return;
    }
    
    let pubsubHandler = pubsubCommands[command];

    if(pubsubHandler !== undefined)
    {        
        pubsubHandler(message, command);
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

    if((typeof feedbackChannel === 'string') && (feedbackChannel.length > 0))
    {
        let payload = {id: message.id, error: err, reply: reply};

        fluidsync.emit('publish', {channel: feedbackChannel, from: proxyName, payload: payload});            
    }
}

//-----------------------------

console.log('Local Redis connector running...');
