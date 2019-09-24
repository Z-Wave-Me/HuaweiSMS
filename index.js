/*** HuaweiSMS Z-Way HA module *******************************************

 Version: 1.0.2
 (c) Z-Wave.Me, 2018
 -----------------------------------------------------------------------------
Author:  Avaliani Alexander <aam@z-wave.me>, Poltorak Serguei <ps@z-wave.me>
Description:
This module allows to send SMS messages and notifications via HUAWEI modem.

 ******************************************************************************/

// ----------------------------------------------------------------------------
// --- Class definition, inheritance and setup
// ----------------------------------------------------------------------------
function HuaweiSMS(id, controller) {
	// Call superconstructor first (AutomationModule)
	HuaweiSMS.super_.call(this, id, controller);

    this.STATE = {
        IDLE: 0,
        TOKEN: 1,
        READ_SMS: 2
    };

    this.readInterval = 10; // in seconds
    this.readQueue = 20; // read 20 first unread messages only - should be enough. Huawei don't work with larger values
}

inherits(HuaweiSMS, AutomationModule);

_module = HuaweiSMS;
// ----------------------------------------------------------------------------
// --- Module instance initialized
// ----------------------------------------------------------------------------
HuaweiSMS.prototype.init = function (config) {
	HuaweiSMS.super_.prototype.init.call(this, config);
	var self = this;

    this.config.title = this.getInstanceTitle();
    this.sendQueue = [];
    this.indecesMarkAsRead = [];

    this.state = this.STATE.IDLE;
    this.ip = this.getModelIP();
    if (this.config.read_interval) this.readInterval = this.config.read_interval;

    // for incoming messages(commands)
    this.msgCount = 0;
    this.commandList = self.config.commands.slice();
    this.whiteList = self.config.white_list.slice();
    this.outGoingList = self.config.phones.slice();

    this.vDev = this.controller.devices.create({
		deviceId: this.constructor.name + "_" + this.id,
		defaults: {
			metrics: {
				level: "on", // it is always on, but usefull to allow bind
				icon: "gesture",
				title: this.getInstanceTitle(),
			}
		},
		overlay: {
            deviceType: 'toggleButton',
            probeType: 'notification_email'
        },
		handler: function (command, args) {
            var smsObject = {};
            if (command === "on") {
                // Send predefined message
                smsObject.message = self.config.prefix;
                smsObject.phone = self.config.phone;
            } else if (command === "send") {
                // Send specific message
                smsObject.message = args.prefix;
                smsObject.phone = args.phone;
            }

            if (!smsObject.message) return;

            if (!smsObject.phone || !smsObject.phone.match(/\+[0-9]{5,}/)) {
                self.addNotification('error', 'Missing or wrong receiver phone number ' + smsObject.phone + '. Please check your configuration in the following app instance: ' + self.config.title, 'module');
            } else {
                self.sendQueue.push(smsObject);
                self.sendMessages();
            }
			self.vDev.set("metrics:level", "on"); // update on ourself to allow catch this event
		},
		moduleId: this.id
	});
    
    this.notificationSMSWrapper = function(notification) {
        if (notification.level === 'mail.notification'){
            // Find instance that matches this notification type
            var instances = self.controller.instances.filter(function (instance){
                return instance.params.phone === notification.type;
            });

            if (instances.length === 0) {
                // Not found. Try to find default instance
                instances = self.controller.instances.filter(function (instance){
                    return instance.moduleId === this.constructor.name;
                });
            }

            if (instances.length) {
                var vDev = self.controller.devices.get(instance[0].moduleId + '_' + instance[0].id);

                if (vDev && instance[0].id === self.vDev.get('creatorId')) {
                    vDev.performCommand('send', {
                        phone: notification.type,
                        message: notification.message
                   });
               }
           }
       }
    };
    this.controller.on('notifications.push', this.notificationSMSWrapper);

    this.timer = setInterval(function(){
        self.readMessages();
    }, this.readInterval*1000);
};

HuaweiSMS.prototype.stop = function () {
    if (this.timer) clearInterval(this.timer);

    this.controller.off("notifications.push",this.notificationSMSWrapper);
	
    if (this.vDev) {
		this.controller.devices.remove(this.vDev.id);
		this.vDev = null;
	}

	HuaweiSMS.super_.prototype.stop.call(this);
};

// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------

HuaweiSMS.prototype.sendMessages = function() {
    if (this.sendQueue.length && this.state === this.STATE.IDLE) {
        this.getToken();
    }
};

HuaweiSMS.prototype.readMessages = function() {
    if (this.state === this.STATE.IDLE || this.state === this.STATE.READ_SMS) { 
        this.getToken();
    }
};

HuaweiSMS.prototype.getToken = function() {
    var self = this;
    if (this.state === this.STATE.IDLE) this.state = this.STATE.TOKEN;

	http.request({
        url: "http://" + this.ip + "/api/webserver/SesTokInfo",
        async: true,
        contentType: "text/xml",
        success: function(resp) {
            if (typeof resp.data !== "object" || !resp.data.isXML) {
                console.log("Bad response: " + resp.data);
                self.state = self.STATE.IDLE;
                return;
            }

            self.session = resp.data.findOne("//SesInfo/text()");
            self.token = resp.data.findOne("//TokInfo/text()");
            self.cookie = self.session;
            if (self.config.user) {
                self.loginRequest();  
            } else {
                self.readSend();
            }      
        },
        error: function(err) {
            self.state = self.STATE.IDLE;
            self.addNotification('error', 'Error getting token from the modem in the following app instance: ' + self.config.title, 'module');
            self.sendMessages();
        }
    });
};

HuaweiSMS.prototype.loginRequest = function() {
    var self = this;
    http.request({
        url: "http://" + this.ip + "/api/user/login",
        async: true,
        method: "POST",
        data: "<request><Username>" + this.config.user + "</Username><Password>" + Base64.encode(this.config.password) + "</Password><password_type>3</password_type></request>",
        headers: {
            "Content-Type": "text/xml",
            "Cookie": this.session,
            "__RequestVerificationToken": this.token
        },
        success: function(resp) {
            self.cookie = resp.headers["Set-Cookie"];
            self.token = resp.headers.__RequestVerificationTokenone;
            if (!self.cookie) {
                self.state = self.STATE.IDLE;
                self.addNotification('error', 'Login to the modem failed in the following app instance: ' + self.config.title, 'module');
                return;
            }
            self.readSend();
        },
        error: function(err) {
            self.state = self.STATE.IDLE;
            self.addNotification('error', 'Error log in to the modem in the following app instance: ' + self.config.title, 'module');
            self.sendMessages();
        } 
    });    
};

HuaweiSMS.prototype.readSend = function() {
    if (this.sendQueue.length) {
        this.sendMessage();
    } else {
        if (this.indecesMarkAsRead.length) {
            this.markAsRead(this.indecesMarkAsRead.shift());
        } else {        
            if (this.state !== this.STATE.READ_SMS) {
                this.checkMessages();
            } else {
                this.getMessages();
            }
        }
    }
};

HuaweiSMS.prototype.checkMessages = function() {
    var self = this;
    http.request({
        url: "http://" + self.ip + "/api/sms/sms-count",
        async: true,
        contentType: "text/xml",
        headers: {
            "Cookie": self.cookie,
       },
        success: function(resp) {
            if (typeof resp.data !== "object" || !resp.data.isXML) {
                console.log("Bad response: " + resp.data);
                return;
            }  
            self.msgCount = parseInt(resp.data.findOne("//LocalUnread/text()"), 10);
            if (self.msgCount) {
                self.state = self.STATE.READ_SMS;
                self.readMessages();
            } else {
                self.state = self.STATE.IDLE;
                self.sendMessages(); // to send messages if queue while we were busy
            }
        },
        error: function(err) {
            self.state = self.STATE.IDLE;
            self.addNotification('error', 'Error checking for message box thru the modem in the following app instance: ' + self.config.title, 'module');
            self.getToken();
        }
    });
};

HuaweiSMS.prototype.getMessages = function(callback) {
    var self = this;
    http.request({
        url: "http://" + this.ip + "/api/sms/sms-list",
        async: true,
        method: "POST",
        contentType: "text/xml",
        data: "<request><PageIndex>1</PageIndex><ReadCount>" + this.readQueue + "</ReadCount><BoxType>1</BoxType><SortType>0</SortType><Ascending>0</Ascending><UnreadPreferred>0</UnreadPreferred></request>",
        headers: {
            "Cookie": this.cookie,
            "__RequestVerificationToken": this.token
        },
        success: function(resp) {     
            if (typeof resp.data !== "object" || !resp.data.isXML) {
                console.log("Bad response: " + resp.data);
                self.state = self.STATE.IDLE;
                return;
            }

            // from older to newer SMS
            for(var i = self.msgCount; i > 0; i--) { 
                var messageObject = {
                    phone: resp.data.findOne("//Message[" + i + "]/Phone/text()"),
                    index: resp.data.findOne("//Message[" + i + "]/Index/text()"),
                    content: resp.data.findOne("//Message[" + i + "]/Content/text()")
                };
                self.indecesMarkAsRead.push(messageObject.index);
                if (self.whiteList.indexOf(messageObject.phone) !== -1) {
                    
                    var cmd = self.commandList.filter(function(cmd) { return cmd.command_name === messageObject.content; })[0];

                    if (!cmd) {
                        self.addNotification('warning', "Command " + messageObject.content + " not found in commands list", 'module');
                    } else {
                        // Send back confirmation
                        var smsObject = {
                            message: "Command <" + messageObject.content + "> done!",
                            phone: messageObject.phone,
                        };
                        self.sendQueue.push(smsObject);

                        var vDev = self.controller.devices.get(cmd.device);
                        if (vDev) {
                            vDev.performCommand("on");
                        }
                    }
                } else {
                    self.addNotification('warning', "Phone number " + messageObject.phone + " is not in your white list", 'module');
                }
            }
            self.state = self.STATE.IDLE;
            self.readMessages();
        },
        error: function(err) {
            self.state = self.STATE.IDLE;
            self.addNotification('error', 'Error getting message box thru the modem in the following app instance: ' + self.config.title, 'module');
            self.sendMessages();
        }
    });
};

HuaweiSMS.prototype.sendMessage = function() {
    var self = this;
    if (this.sendQueue.length === 0) return;

    var smsObject = this.sendQueue.shift();

    console.log("Sending SMS...");
    http.request({
        url: "http://" + self.ip + "/api/sms/send-sms",
        async: true,
        method: "POST",
        contentType: "text/xml",
        data: "<request><Index>-1</Index><Phones><Phone>" + smsObject.phone + "</Phone></Phones><Sca></Sca><Content>"+ self.escapeXML(smsObject.message) + "</Content><Length>-1</Length><Reserved>1</Reserved><Date>-1</Date></request>",
        headers: {
            "Content-Type": "text/xml",
            "Cookie": self.cookie,
            "__RequestVerificationToken": self.token
        },
        success: function(resp) {
            if (typeof resp.data !== "object" || !resp.data.isXML) {
                console.log("Bad response: " + resp.data);
                self.state = self.STATE.IDLE;
                return;
            }

            var errCode = resp.data.findOne("//error/code/text()");
            if (errCode) {
                self.addNotification('error', 'Error sending message SMS. Error code: ' + errCode + ', instance: ' + self.config.title, 'module');
            } else {
                console.log("SMS sent");
            }

            self.state = self.STATE.IDLE;
            self.sendMessages();
        },
        error: function(err) {
            self.state = self.STATE.IDLE;
            self.addNotification('error', 'Error sending message thru the modem in the following app instance: ' + self.config.title, 'module');
            self.sendMessages();
        }
    });        
};

HuaweiSMS.prototype.markAsRead = function(index) {
    var self = this ;
    http.request({
        url: "http://" + self.ip + "/api/sms/set-read",
        async: true,
        method: "POST",
        contentType: "text/xml",
        data: "<request><Index>"+ index +"</Index></request>",
        headers: {
            "Content-Type": "text/xml",
            "Cookie": self.cookie,
            "__RequestVerificationToken": self.token
        },
        success: function(resp) {
            if (typeof resp.data !== "object" || !resp.data.isXML) {
                console.log("Bad response: " + resp.data);
                self.state = self.STATE.IDLE;
                return;
            }

            var errCode = resp.data.findOne("//error/code/text()");
            if (errCode) {
                self.addNotification('error', 'Error marking as read. Error code: ' + errCode + ', instance: ' + self.config.title, 'module');
            }

            self.state = self.STATE.IDLE;
            self.readMessages();
        },
        error: function(err) {
            self.state = self.STATE.IDLE;
            self.addNotification('error', 'Error marking message as read box thru the modem in the following app instance: ' + self.config.title, 'module');
            self.readMessages();
        }
    });
};

HuaweiSMS.prototype.getModelIP = function() {
    switch(this.config.modem_to_select) {
        case "E303s-2":
        case "M100-4":
        case "824FT":
        case "824F"
            return "192.168.1.1";

        case "E3372":
        case "E8372":
        case "E3272":
        default:
            return "192.168.8.1";
    }
};

HuaweiSMS.prototype.escapeXML = function(str) {
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&apos;');
}
