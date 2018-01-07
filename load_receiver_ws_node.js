const util = require('util');
const process = require('process');

const FluidSyncClient = require('./fluidsync_ws_client.js');

const communicatorHost = 'wss://fluidsync2.herokuapp.com';

const channelToListen = 'mychannel';

let arg = process.argv[2];

const clientsCount = arg ? Number.parseInt(arg) : 100;

let clients = [];

let countOfConnected = 0;
let countOfAnswers = 0;

function onOpen(fluidsync)
{
    //console.log('connected: ' + fluidsync.id);

    fluidsync.subscribe('mychannel');

    ++countOfConnected;
    
    if(countOfConnected === clientsCount)
    {
        countOfConnected = 0;

        console.log('all connected...');
    }
}

function onError(fluidsync)
{
    //console.log('error ['  + fluidsync.id + ']');

    console.log('connect error');

    process.exit();
}

function onChannelMessage(fluidsync, message)
{
    ++countOfAnswers;
        
    let info = util.format('%s : message came (%d)', (new Date()).toLocaleString(), countOfAnswers);
    
    process.stdout.cursorTo(0); 
    process.stdout.write(info);
}

for(let i = 0; i < clientsCount; ++i)
{
    let fluidsync = new FluidSyncClient({    
        serverUrl: communicatorHost,            
        onOpen: onOpen,
        onError: onError
    });
    
    fluidsync.addEventListener('mychannel', onChannelMessage);
            
    clients.push(fluidsync);    
}

//-----------------------------

console.log('connecting ' + clientsCount + ' client sockets...');
