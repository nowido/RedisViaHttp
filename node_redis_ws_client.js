const RedisProxy = require('fluidsync_redis_proxy');

const redis = new RedisProxy({
    remoteNodeName: 'unique_instance_name',
    onConnect: onConnect
});

function onConnect(eventType, redis)
{
    console.log('FluidSync2 Redis connection: ' + redis.redisSocket.id);
    
    redis.sendCommand('subscribe', ['poo'], (err, reply) => {                    
        console.log(err);
        console.log(reply);
    });    
}

function onPubsubEvent(eventType, message)
{
    console.log(message); 
}

redis.addEventListener('pubsub_event', onPubsubEvent);

process.on('SIGINT', () => {

    console.log('\ngot SIGINT, closing...');

    redis.sendCommand('unsubscribe', ['poo'], (err, reply) => {                    
        console.log(err);
        console.log(reply);

        process.exit();
    });        
});