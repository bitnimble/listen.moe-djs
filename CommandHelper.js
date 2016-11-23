const EventEmitter = require("events").EventEmitter;

class CommandHelper extends EventEmitter {
    constructor(prefix) {
        super();
        this.prefix = prefix || "~~";
        this.commands = new Map();
    }
    
    register(command, fn) {
        this.commands.set(command, fn);
    }

    process(msg) {
        let msgString = msg.content;
        if (!msgString.startsWith(this.prefix))
            return;
        //Remove prefix
        msgString = msgString.substr(this.prefix.length);

        //Separate command and arguments (if it has arguments)
        let command = msgString;
        if (msgString.includes(" "))
            command = msgString.substring(0, msgString.indexOf(" "));

        //Get the mapped function
        let fn;
        if (!(fn = this.commands.get(command)))
            return;

        let argument = msgString.substr(msgString.indexOf(" ") + 1);
        fn(msg, argument);
    }
}

module.exports = CommandHelper;