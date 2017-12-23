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
    'PSUBSCRIBE': true,        
    'PUNSUBSCRIBE': true,
    'SUBSCRIBE': true,
    'UNSUBSCRIBE': true
};

//-----------------------------

const channelPrefix = 'rc#';
const patternPrefix = 'rp#';

const channelPrefixLength = channelPrefix.length;
const patternPrefixLength = patternPrefix.length;

var subscriptionsRegistry = 
{
        // dictionary to register remote listeners ('event channels') subscribed for 'some channel'
        // this object is keyed with 'some channels' (prefixed)
        // and contains objects keyed with 'event channels' (prefixed)
    channels: 
    {
        /*
        {prefixed eventChannels} 
        */
    },

        // dictionary to register remote listeners ('event channels') subscribed for 'some pattern'
        // this object is keyed with 'some patterns' (prefixed) 
        // and contains objects keyed with 'event channels' (prefixed)
    patterns: 
    {
        /*
        {prefixed eventChannels} 
        */
    },

        // reverse dictionary to speed up registry management
        // this object is keyed with 'event channels' (prefixed)
        // and contains object keyed with 'some channels' and 'some patterns',
        // so we can remove client's subscriptions without iterating over direct dictionaries
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
subscriptionsRegistry.addChannel = (isActive, channel, eventChannel) =>
{    
    let prefixedChannel = channelPrefix + channel;
    let prefixedEventChannel = channelPrefix + eventChannel;

    subscriptionsRegistry.addToDirectDictionary(isActive, prefixedEventChannel, prefixedChannel, 'channels')

    subscriptionsRegistry.addToReverseDictionary(isActive, prefixedEventChannel, prefixedChannel, 'channels');
};

    //
subscriptionsRegistry.addPattern = (isActive, pattern, eventChannel) =>
{    
    let prefixedPattern = patternPrefix + pattern;
    let prefixedEventChannel = channelPrefix + eventChannel;

    subscriptionsRegistry.addToDirectDictionary(isActive, prefixedEventChannel, prefixedPattern, 'patterns')

    subscriptionsRegistry.addToReverseDictionary(isActive, prefixedEventChannel, prefixedPattern, 'patterns');
};

subscriptionsRegistry.addToDirectDictionary = (isActive, prefixedEventChannel, prefixedToken, dictionary) =>
{
    let tokens = subscriptionsRegistry[dictionary];

    let entry = tokens[prefixedToken];

    if(entry === undefined)
    {
        entry = tokens[prefixedToken] = {};
    }

    entry[prefixedEventChannel] = isActive;        
}

subscriptionsRegistry.addToReverseDictionary = (isActive, prefixedEventChannel, prefixedToken, dictionary) => 
{
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

    if((dictionary !== undefined) && (prefixedToken !== undefined))
    {
        reverseEntry[dictionary][prefixedToken] = isActive;    
    }    
};

subscriptionsRegistry.removeInactiveChannel = (channel) => {

    let prefixedChannel = channelPrefix + channel;

    let prefixedEventChannels = subscriptionsRegistry.removeInactiveFromDirectDictionary
                                    (prefixedChannel, 'channels');
    
    subscriptionsRegistry.removeInactiveFromReverseDictionary(prefixedEventChannels);
}

subscriptionsRegistry.removeInactivePattern = (pattern) => {

    let prefixedPattern = patternPrefix + pattern;

    let prefixedEventChannels = subscriptionsRegistry.removeInactiveFromDirectDictionary
                                    (prefixedPattern, 'patterns');
                                        
    subscriptionsRegistry.removeInactiveFromReverseDictionary(prefixedEventChannels);
}

subscriptionsRegistry.removeInactiveFromDirectDictionary = (prefixedToken, dictionary) => 
{
    let inactivePrefixedEventChannels = [];

    let tokens = subscriptionsRegistry[dictionary];

    let entry = tokens[prefixedToken];

    if(entry !== undefined)
    {
        let prefixedEventChannelsKeys = Object.keys(entry);
        
        for(let i = 0; i < prefixedEventChannelsKeys.length; ++i)
        {
            let prefixedEventChannel = prefixedEventChannelsKeys[i];

            if(entry[prefixedEventChannel] === false)
            {
                inactivePrefixedEventChannels.push(prefixedEventChannel);    

                delete entry[prefixedEventChannel];
            }
        }
    }
    
    return inactivePrefixedEventChannels;
}

subscriptionsRegistry.removeInactiveFromReverseDictionary = (inactivePrefixedEventChannels, dictionary) => 
{
    let reverseRegistry = subscriptionsRegistry.eventChannels;

    for(let i = 0; i < inactivePrefixedEventChannels.length; ++i)
    {
        let prefixedEventChannel = inactivePrefixedEventChannels[i];

        let entry = reverseRegistry[prefixedEventChannel];

        if(entry !== undefined)
        {                        
            let tokens = entry[dictionary];

            let tokenKeys = Object.keys(tokens);

                // select and remove inactive tokens for this entry

            for(let j = 0; j < tokenKeys.length; ++j)
            {
                let tokenKey = tokenKeys[j];

                if(tokens[tokenKey] === false)
                {
                    delete tokens[tokenKey];
                }

            } // end for j

        } // end if(entry !== undefined)

    } // end for i
}

subscriptionsRegistry.removeSubscription = (prefixedEventChannel) => 
{
    let reverseRegistry = subscriptionsRegistry.eventChannels;

    let reverseEntry = reverseRegistry[prefixedEventChannel];

    if(reverseEntry === undefined)
    {
        return;
    }

    let prefixedChannelsKeys = undefined;

    if(reverseEntry.channels !== undefined)
    {
        prefixedChannelsKeys = Object.keys(reverseEntry.channels);
    }

    let prefixedPatternsKeys = undefined;

    if(reverseEntry.patterns !== undefined)
    {
        prefixedPatternsKeys = Object.keys(reverseEntry.patterns);
    }
    
    let channelsKeys = undefined;

    if(prefixedChannelsKeys)
    {
        channelsKeys = [];

        let channels = subscriptionsRegistry.channels;

        for(let i = 0; i < prefixedChannelsKeys.length; ++i)
        {
            let prefixedChannel = prefixedChannelsKeys[i];

            channelsKeys[i] = prefixedChannel.substr(channelPrefixLength);

            let subscribers = channels[prefixedChannel];

            if(subscribers !== undefined)
            {
                delete subscribers[prefixedEventChannel];
            }            

            if(Object.keys(subscribers).length === 0)
            {
                delete channels[prefixedChannel];
            }
        }
    }

    let patternsKeys = undefined;

    if(prefixedPatternsKeys)
    {
        patternsKeys = [];

        let patterns = subscriptionsRegistry.patterns;

        for(let i = 0; i < prefixedPatternsKeys.length; ++i)
        {
            let prefixedPattern = prefixedPatternsKeys[i];

            patternsKeys[i] = prefixedPattern.substr(patternPrefixLength);

            let subscribers = patterns[prefixedPattern]; 

            if(subscribers !== undefined)
            {
                delete subscribers[prefixedEventChannel];
            }                        

            if(Object.keys(subscribers).length === 0)
            {
                delete patterns[prefixedPattern]; 
            }
        }        
    }

    delete reverseRegistry[prefixedEventChannel];

    if(channelsKeys && (channelsKeys.length > 0))
    {
        redisSubscribedClient.send_command('unsubscribe', channelsKeys);
    }
    
    if(patternsKeys && (patternsKeys.length > 0))
    {
        redisSubscribedClient.send_command('punsubscribe', patternsKeys);
    }
}

//-----------------------------

function subscribe(message, method, command)
{
    let entries = message.args;

    if(entries === undefined)
    {
        return;
    }

    let eventChannel = message.eventChannel;

    if(typeof eventChannel !== 'string')
    {
        return;
    }

        // add entries (channels or patterns) to registry in presumption that Redis takes them correctly

    for(let i = 0; i < entries.length; ++i)
    {
        subscriptionsRegistry[method](true, entries[i], eventChannel);        
    }            

    if(!garbageCollectionPresent)
    {
        garbageCollectionIntervalId = setInterval(onGarbageCollectorTick, GARBAGE_COLLECTOR_PERIOD);

        garbageCollectionPresent = true;

        //console.log('garbage collector is now on');        
    }
    
    redisSubscribedClient.send_command(command, entries, (err, reply) => {        

        sendReply(message, err, reply);        
    });        
}

function unsubscribe(message, method, command)
{
    let entries = message.args;

    if(entries === undefined)
    {
        return;
    }
        
    // we do not clean up subscriptions registry for gone subscription right now,    
    // because we need to inform unsubscribing client on further 'unsubscribe' events;
    // so, we modify registry entries (channels or patterns) marking them as 'inactive' (but present)

    // we unregister in presumption that Redis takes unsubscriptions correctly

    let eventChannel = message.eventChannel;

    if(typeof eventChannel === 'string')
    {
        for(let i = 0; i < entries.length; ++i)
        {
            subscriptionsRegistry[method](false, entries[i], eventChannel);        
        }                        
    }
        
    redisSubscribedClient.send_command(command, entries, (err, reply) => {        

        sendReply(message, err, reply);        
    });    
}

function notifySubscribersOnChannelEvent(channel, message)
{
    let prefixedChannel = channelPrefix + channel;

    notifySubscribersOnPubsubEvent(prefixedChannel, 'channels', message);
}

function notifySubscribersOnPatternEvent(pattern, message)
{
    let prefixedPattern = patternPrefix + pattern;

    notifySubscribersOnPubsubEvent(prefixedPattern, 'patterns', message);
}

function notifySubscribersOnPubsubEvent(prefixedToken, dictionary, message)
{
    let subscribers = subscriptionsRegistry[dictionary][prefixedToken];    

    if(subscribers === undefined)
    {
        return;
    }

    let eventChannels = Object.keys(subscribers);
    
    for(let i = 0; i < eventChannels.length; ++i)
    {
        let eventChannel = eventChannels[i].substr(channelPrefixLength);

        fluidsync.emit('publish', {channel: eventChannel, from: proxyName, payload: message});     
    }
}

//-----------------------------

redisSubscribedClient.on('message', (channel, message) => {

    notifySubscribersOnChannelEvent(channel, 
        {event: 'message', channel: channel, message: message});    
});

redisSubscribedClient.on('pmessage', (pattern, channel, message) => {
    
    notifySubscribersOnPatternEvent(pattern, 
        {event: 'pmessage', pattern: pattern, channel: channel, message: message});
});

/*
redisSubscribedClient.on('message_buffer', (channel, message) => {

    notifySubscribersOnChannelEvent(channel, 
        {event: 'message_buffer', channel: channel, message: message});
});

redisSubscribedClient.on('pmessage_buffer', (pattern, channel, message) => {

    notifySubscribersOnPatternEvent(pattern, 
        {event: 'pmessage_buffer', pattern: pattern, channel: channel, message: message});
});
*/

redisSubscribedClient.on('subscribe', (channel, count) => {

    notifySubscribersOnChannelEvent(channel, 
        {event: 'subscribe', channel: channel, count: count});
});

redisSubscribedClient.on('psubscribe', (pattern, count) => {

    notifySubscribersOnPatternEvent(pattern, 
        {event: 'psubscribe', pattern: pattern, count: count});
});

redisSubscribedClient.on('unsubscribe', (channel, count) => {

    notifySubscribersOnChannelEvent(channel, 
        {event: 'unsubscribe', channel: channel, count: count});

    subscriptionsRegistry.removeInactiveChannel(channel);
});

redisSubscribedClient.on('punsubscribe', (pattern, count) => {

    notifySubscribersOnPatternEvent(pattern, 
        {event: 'punsubscribe', pattern: pattern, count: count});

    subscriptionsRegistry.removeInactivePattern(pattern);
});

//-----------------------------

function updateTimeLicense(message)
{
    let eventChannel = message.eventChannel;

    if(typeof eventChannel !== 'string')
    {
        return;
    }

    let prefixedEventChannel = channelPrefix + eventChannel;

    subscriptionsRegistry.addToReverseDictionary(true, prefixedEventChannel);
}

//-----------------------------

const GARBAGE_COLLECTOR_PERIOD = 20 * 1000; // 20 min

const TIME_LICENSE_PERIOD = 30 * 1000; // 30 min

var garbageCollectionPresent = false;
var garbageCollectionIntervalId;

    //
function onGarbageCollectorTick()
{
    let timeNow = Date.now();

    let reverseRegistry = subscriptionsRegistry.eventChannels;

    let prefixedEventChannels = Object.keys(reverseRegistry);

    for(let i = 0; i < prefixedEventChannels.length; ++i)
    {
        let prefixedEventChannel = prefixedEventChannels[i];

        let reverseEntry = reverseRegistry[prefixedEventChannel];

        let age = timeNow - reverseEntry.timestamp;

        //console.log(prefixedEventChannel + ': ' + age + ': (of ' + TIME_LICENSE_PERIOD + ')');

        if(age >= TIME_LICENSE_PERIOD)
        {
            subscriptionsRegistry.removeSubscription(prefixedEventChannel);
        }
    }

    if(Object.keys(reverseRegistry).length === 0)
    {
        clearInterval(garbageCollectionIntervalId);

        garbageCollectionPresent = false;

        //console.log('garbage collector is now off');
    }
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
    }
    else if(pubsubCommands[command])
    {
        if(command === 'SUBSCRIBE')
        {
            subscribe(message, 'addChannel', command);            
        }
        else if(command === 'PSUBSCRIBE')
        {
            subscribe(message, 'addPattern', command);
        }
        else if(command === 'UNSUBSCRIBE')
        {
            unsubscribe(message, 'addChannel', command);            
        }
        else if(command === 'PUNSUBSCRIBE')
        {
            unsubscribe(message, 'addPattern', command);            
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

    fluidsync.emit('publish', 
        {channel: feedbackChannel, from: proxyName, payload: {id: message.id, error: err, reply: reply}});            
}

//-----------------------------

console.log('Local Redis connector running...');
