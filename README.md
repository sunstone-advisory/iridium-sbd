# Iridium SBD 9602/9603 Transciever Driver

## Overview
Node.js driver for Iridium SBD 9602/9603 transceiver modules. 

## Basic Usage
```js
const controller = new IridiumController({
  serialPath: '/dev/serial0',
  serialBaudRate: 19200
})

controller.on('log', (log) => console[log.level.toLowerCase()](log.message));

try {
  // open the serial port and init the iridium modem
  controller.init()
    .then(() => 
      controller.sendMessage('Hello Iridium from Node.js', { signalQuality: 2, compressed: false, binary: false }
    ))
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
```