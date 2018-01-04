const util = require('util');
const process = require('process');

// web sockets client
const io = require('socket.io-client');

const communicatorHost = 'https://fluidsync2.herokuapp.com';

const channelToListen = 'mychannel';

let arg = process.argv[2];

const clientsCount = arg ? Number.parseInt(arg) : 100;

let clients = [];

let countOfConnected = 0;
let countOfAnswers = 0;

for(let i = 0; i < clientsCount; ++i)
{
    let fluidsync = io(communicatorHost, {transports: ['websocket']});

    fluidsync.on(channelToListen, (message) => {

        //console.log(message);
        ++countOfAnswers;
        
        let info = util.format('%s : message came (%d)', (new Date()).toLocaleString(), countOfAnswers);
        
        process.stdout.cursorTo(0); 
        process.stdout.write(info);
    });

    fluidsync.on('connect', () => {

        ++countOfConnected;

        fluidsync.emit('subscribe', channelToListen);

        if(countOfConnected === clientsCount)
        {
            countOfConnected = 0;

            console.log('all connected...');
        }
    });        
    
    fluidsync.on('connect_error', (e) => {
                
        console.log('connect error: ' + e);

        process.exit();
    });

    clients.push(fluidsync);    
}

//-----------------------------

console.log('connecting ' + clientsCount + ' client sockets...');
