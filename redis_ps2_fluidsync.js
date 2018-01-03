    // Redis client
const redis = require('redis');

    // to do use config file or commandline arg to specify Redis server attributes
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
const fluidsync = io('https://fluidsync2.herokuapp.com', {transports: ['websocket']});  

var fluidsyncSocketId;

    // potential clients must know proxyName to compose command channel
const proxyName = 'unique_instance_name';

const proxyChannel = 'redis-command-' + proxyName;

const proxyPresenceChannel = 'redis-present-' + proxyName;

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

const blockingCommands = 
{
    'BLPOP': true,
    'BRPOP': true,
    'BRPOPLPUSH': true
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

    let subscribersCount = 0;

    if(eventChannelsForToken !== undefined)
    {
        eventChannelsForToken.delete(eventChannel);
        
        subscribersCount = eventChannelsForToken.size;

        if(subscribersCount === 0)
        {
            tokensMap.delete(token);   
        }
    }

    return subscribersCount;
}

subscriptionsRegistry.removeFromReverseDictionary = (eventChannel, token, dictionary) => 
{
    let reverseRegistry = subscriptionsRegistry.eventChannels;

    let reverseEntry = reverseRegistry.get(eventChannel);

    let tokensCount = 0;

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

            tokensCount = reverseEntry[dictionary].size;
        }
    }    
    
    return tokensCount;
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
        
        if((reverseEntry.channels.size === 0) && (reverseEntry.patterns.size === 0))
        {
            subscriptionsRegistry.eventChannels.delete(eventChannel);    
        }
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
        if(entries && (entries.forEach !== undefined) && (entries.length > 0))
        {
            // add entries (channels) to registry in presumption that Redis takes them correctly    

            let stableEntries = [];

            entries.forEach(channel => {

                if((typeof channel === 'string') && (channel.length > 0))
                {
                    stableEntries.push(channel);

                    let subscribersCount = subscriptionsRegistry.addChannel(channel, eventChannel); 
    
                    let wrappedMessage = 
                    {
                        event: 'subscribe', 
                        channel: channel, 
                        count: subscribersCount,
                        proxySocketId: fluidsyncSocketId
                    };
    
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

        sendError(message, ERR_NO_ANONYMOUS_SUBSCRIBE);
    }           
}

function subscribeForPatterns(message, command)
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

                    let subscribersCount = subscriptionsRegistry.addPattern(pattern, eventChannel); 
    
                    let wrappedMessage = 
                    {
                        event: 'psubscribe', 
                        pattern: pattern, 
                        count: subscribersCount,
                        proxySocketId: fluidsyncSocketId
                    };
    
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

        sendError(message, ERR_NO_ANONYMOUS_SUBSCRIBE);
    }           
}

function unsubscribeFromChannels(message, command)
{
    let eventChannel = message.eventChannel;

    let entries = message.args;

    if((typeof eventChannel === 'string') && (eventChannel.length > 0))
    {   
        let stableEntries = undefined;

        if(entries && (entries.forEach !== undefined) && (entries.length > 0))
        {
            // remove entries (channels) from registry in presumption that Redis takes unsubscription correctly    
            
            stableEntries = [];

            entries.forEach(channel => {

                if((typeof channel === 'string') && (channel.length > 0))
                {
                    stableEntries.push(channel);

                    let subscribersCount = subscriptionsRegistry.removeChannel(channel, eventChannel); 
    
                    let wrappedMessage = {event: 'unsubscribe', channel: channel, count: subscribersCount};
    
                    fluidsync.emit('publish', {channel: eventChannel, from: proxyName, payload: wrappedMessage});                                
                }
            });
        }
        else 
        {
            // no entries (channels) specified to unsubscribe from

            // so, unsubscribe this client from all channels

            stableEntries = subscriptionsRegistry.removeTokensSubscription(eventChannel, 'channels');  
        }

        if(stableEntries && (stableEntries.length > 0))
        {
            stopGarbageCollectorIfNeeded();

            sendReply(message, null, stableEntries);                                    

            removeTokensSubscriptionFromRedis(stableEntries, 'unsubscribe', 'channels');
        }            
    }
    else
    {
        // eventChannel is undefined or of incorrect type

        sendError(message, ERR_NO_ANONYMOUS_UNSUBSCRIBE);
    }           
}

function unsubscribeFromPatterns(message, command)
{
    let eventChannel = message.eventChannel;

    let entries = message.args;

    if((typeof eventChannel === 'string') && (eventChannel.length > 0))
    {        
        let stableEntries = undefined;

        if(entries && (entries.forEach !== undefined) && (entries.length > 0))
        {
            // remove entries (patterns) from registry in presumption that Redis takes unsubscription correctly    

            stableEntries = [];

            entries.forEach(pattern => {

                if((typeof pattern === 'string') && (pattern.length > 0))
                {
                    stableEntries.push(pattern);

                    let subscribersCount = subscriptionsRegistry.removePattern(pattern, eventChannel); 
    
                    let wrappedMessage = {event: 'punsubscribe', pattern: pattern, count: subscribersCount};
    
                    fluidsync.emit('publish', {channel: eventChannel, from: proxyName, payload: wrappedMessage});                                
                }
            });
        }
        else 
        {
            // no entries (patterns) specified to unsubscribe from

            // so, unsubscribe this client from all patterns

            stableEntries = subscriptionsRegistry.removeTokensSubscription(eventChannel, 'patterns');  
        }

        if(stableEntries && (stableEntries.length > 0))
        {
            stopGarbageCollectorIfNeeded();

            sendReply(message, null, stableEntries);                                    

            removeTokensSubscriptionFromRedis(stableEntries, 'punsubscribe', 'patterns');            
        }                    
    }
    else
    {
        // eventChannel is undefined or of incorrect type

        sendError(message, ERR_NO_ANONYMOUS_UNSUBSCRIBE);
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
    removeTokensSubscriptionFromRedis(entries.channels, 'unsubscribe', 'channels');
    removeTokensSubscriptionFromRedis(entries.patterns, 'punsubscribe', 'patterns');
}

function removeTokensSubscriptionFromRedis(tokens, command, dictionary)
{
    // unsubscribe from Redis only if no one now listens;
    // corresponding entries (channels|patterns) must be previously removed from subscriptions registry

    if(tokens && (tokens.length > 0))
    {
        let tokensToUnsubscribe = [];

        let tokensMap = subscriptionsRegistry[dictionary];
        
        tokens.forEach(token => {

            if(tokensMap.get(token) === undefined)
            {
                tokensToUnsubscribe.push(token);                
            }
        });        

        if(tokensToUnsubscribe.length > 0)
        {
            redisSubscribedClient.send_command(command, tokensToUnsubscribe);
        }
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

const GARBAGE_COLLECTOR_PERIOD = 3 * 60 * 1000; // 3 min

const TIME_LICENSE_PERIOD = 5 * 60 * 1000; // 5 min

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

    // we broadcast 'presence_heartbeat' event to all remote clients
    // this is period of presence notifications
const PRESENCE_HEARTBEAT_PERIOD = 1 * 60 * 1000; // 1 min

var presenceIntervalId;

function startPresence()
{
    if(presenceIntervalId === undefined)
    {
        presenceIntervalId = setInterval(onPresenceTick, PRESENCE_HEARTBEAT_PERIOD);
    }
}

function stopPresence()
{
    if(presenceIntervalId !== undefined)
    {
        clearInterval(presenceIntervalId);

        presenceIntervalId = undefined;
    }    
}

function onPresenceTick()
{
    if(fluidsyncSocketId !== undefined)
    {
        let wrappedMessage = {event: 'presence_heartbeat', proxySocketId: fluidsyncSocketId};

        fluidsync.emit('publish', {channel: proxyPresenceChannel, from: proxyName, payload: wrappedMessage}); 
    }
}

//-----------------------------

fluidsync.on('connect', () => {

    fluidsyncSocketId = fluidsync.id;

        // now we will receive commands from remote nodes (through FluidSync)
    fluidsync.emit('subscribe', proxyChannel);    

    startPresence();

    console.log('connected to FluidSync');
});

fluidsync.on('reconnect', () => {

    console.log('reconnect to FluidSync ...');        
});    

fluidsync.on('disconnect', () => {

    fluidsyncSocketId = undefined;

    stopPresence();

    console.log('disconnected from FluidSync');        
});    

//-----------------------------

fluidsync.on(proxyChannel, function (data) 
{
    console.log(data);
    
    let message = data.payload;

    if(message === undefined)
    {
        return;
    }

    let command = message.command;

    if(typeof command === 'string')
    {
        command = command.trim().toUpperCase();

        if(command.length > 0)
        {
            if(command === 'HEARTBEAT')
            {
                updateTimeLicense(message);
                return;
            }
            
            if(command === 'PXPACK')
            {
                executeCommandsPack(message);
                return;
            }

            if(blockingCommands[command])
            {
                sendError(message, ERR_BLOCKING_UNSUPPORTED);    
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
        }
    }
});

//-----------------------------

function executeCommandsPack(message)
{
    let commandsPack = message.pack;

    if(commandsPack && commandsPack.forEach)
    {
        let stableEntries = [];

        commandsPack.forEach(entry => {

            if(entry)
            {
                let command = entry.command;

                if(typeof command === 'string')
                {
                    command = command.trim().toUpperCase();

                    if(command.length > 0)
                    {
                        if(blockingCommands[command])
                        {
                            sendError(message, ERR_BLOCKING_UNSUPPORTED);
                            return;
                        }
                                           
                        if(pubsubCommands[command])
                        {        
                            sendError(message, ERR_PUBSUB_IN_PACK_UNSUPPORTED);
                            return;
                        }
                        
                        stableEntries.push(entry);    
                    }
                }    
            }
            
        }); // end each entry in commandsPack is valid

        if(stableEntries.length > 0)
        {
            let packBatch = [];

            stableEntries.forEach(entry => {

                let commandItem = [entry.command];

                let commandItemArgs = entry.args;

                if(commandItemArgs && commandItemArgs.forEach)
                {
                    commandItemArgs.forEach(itemArg => {
                        commandItem.push(itemArg);
                    });
                }

                packBatch.push(commandItem);
            });

            redisClient.batch(packBatch).exec((err, reply) => {        
        
                sendReply(message, err, reply);            
            });

        } // end if stableEntries are of non-zero length

    } // end if valid commands pack
}

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

function sendError(message, info)
{
    let err = 
    {
        args: message.args, 
        command: message.command, 
        code: 'ERR', 
        info: info
    };

    sendReply(message, err, null);
}           

//-----------------------------

const ERR_BLOCKING_UNSUPPORTED = 'blocking commands unsupported';
const ERR_PUBSUB_IN_PACK_UNSUPPORTED = 'publish/subscribe commands unsupported in packs';
const ERR_NO_ANONYMOUS_SUBSCRIBE = 'no anonymous subscribe allowed in shared environment';
const ERR_NO_ANONYMOUS_UNSUBSCRIBE = 'no anonymous unsubscribe allowed in shared environment';

//-----------------------------

console.log('Local Redis connector running...');
