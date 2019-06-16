var request = require('request-promise-native');
var fs = require('fs');
var nodemailer = require("nodemailer");
var jsdom = require('jsdom');
const { JSDOM } = jsdom;

var params = {
    Username: null,
    Password: null,
    RememberMe: true
};

// setup e-mail data with unicode symbols
var mailOptions = {
    from: null, // sender address
    to: null, // list of receivers
    subject: "New Flight Opening", // Subject line
    text: null // plaintext body
};

var smtpConfig = {
    host: null,
    port: null,
    secure: null,
    auth: {
      user: null,
      pass: null
    }
};

function serialize(obj) {
    let str = Object.keys(obj).reduce(function(a, k){
        a.push(k + '=' + encodeURIComponent(obj[k]));
        return a;
    }, []).join('&');
    return str;
}

// Login to the application
function login() {
  return request({
      uri: 'https://rfs.skymanager.com/Home/LogIn',
      method: 'POST',
      headers: {
          "Content-Type" : "application/x-www-form-urlencoded",
          'Content-Length' : paramsString.length
      },
      body: paramsString,
      resolveWithFullResponse: true
  }).then((response) => {
      // Save out cookies
      var sessionCookie = response.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join("; ");
      fs.writeFile('sessionCookie.txt', sessionCookie, function (err)
      {
          if(err)
          {
              throw err;
          }
      });
  }).catch((error) => {
      throw error;
  });
}


fs.readFile('credentials.txt','utf8', (err, data) => {
    if(err)
    {
         throw err;
    }
    let creds = JSON.parse(data);
    params.Username = creds.Username;
    params.Password = creds.Password;

    mailOptions.from = creds.mail.from;
    mailOptions.to = creds.mail.to;

    smtpConfig = creds.smtp;
});

var paramsString = serialize(params);

let loginWithSession = () => {
    return new Promise((resolve, reject) => {
        fs.readFile('sessionCookie.txt','utf8', function (err, data) {
            if(err)
            {
                 reject(err);
            }
            else {
                resolve(request({
                    uri: 'https://rfs.skymanager.com/Instructor/Info/309230',
                    method: 'GET',
                    headers: {"Cookie" : data},
                    resolveWithFullResponse: true
                }).then(async (response) => {
                    if (response.statusCode === 500) {
                        console.log("Logging in");
                        await login();
                    } else {
                        console.log("Using Previous Session");
                    }
                }).catch((err) => {
                    throw err;
                }));
            }
        });
    });
}

let getAvailableSlots = (document, minSlotMinutes, dayRange) => {
  var available = Array.from(document.querySelectorAll(".Day, .TodayDay")).map(day => Array.from(day.childNodes).map(n => {
    // Convert times to minute arrays
    if (n.attributes && n.className !== "tooltip") {
      let times = (/(\d+):(\d+)([ap]m)\s*-\s*(\d+):(\d+)([ap]m)/g).exec(n.childNodes[0].textContent);
      if (times) {
        return [parseInt(times[1] !== "12" ? times[1] : 0)*60 + (times[3] === "pm" ? 12*60 : 0) + parseInt(times[2]), parseInt(times[4] !== "12" ? times[4] : 0)*60 + (times[6] === "pm" ? 12*60 : 0) + parseInt(times[5])];
      }
    }
  }).filter(item => item !== undefined)).map((times, dayOffset) => {
    // Get the day of the week
    let dateString = document.querySelectorAll(".Day, .TodayDay")[0].querySelector("a").attributes["href"].value.match(/(\d+-\d+-)\d+/)[1] + (dayOffset + 1);
    let weekDay = (new Date(dateString)).getUTCDay();
    let validTimes = times.filter(time => {
      return time[1] > dayRange[weekDay][0];
    });
    return validTimes.reduce((valid, t, index, arr) => {
      if (index == arr.length - 1 && dayRange[weekDay][1] - t[1] >= minSlotMinutes) {
        valid.push([t[1], dayRange[weekDay][1]]);
      }
      let earliest = dayRange[weekDay][0];
      if (index ? t[0] - arr[index-1][1] >= minSlotMinutes : t[0] - (earliest) >= minSlotMinutes) {
        valid.push([index ? arr[index-1][1] : (earliest), t[0]]);
      }
      return valid;
    }, validTimes.length > 0 || dayRange[weekDay][0] == dayRange[weekDay][1] ? [] : [[dayRange[weekDay][0], dayRange[weekDay][1]]]);
    //return times;//index ? t[0] - arr[index-1][1] > 120 : t[0] - (17*60) > 120
  });

  return available;
}

let diffSlots = (newSlots) => {
    return new Promise((resolve, reject) => {
        fs.readFile('slots.txt','utf8', function (err, oldSlotsText) {
            if(err) {
                reject(err);
            }
            let oldSlots = JSON.parse(oldSlotsText);
            resolve(Object.keys(oldSlots).reduce((months, month) => {
                let oldMonth = oldSlots[month];
                let newMonth = newSlots[month];
                if (!newMonth) {
                    return months;
                }
                months[month] = oldMonth.map((oldDay, dayIndex) => {
                    let newDay = newMonth[dayIndex];
                    return newDay.reduce((added, newSlot) => {
                        if (!oldDay.find((oldSlot) => {
                            return oldSlot[0] == newSlot[0] && oldSlot[1] == newSlot[1];
                        })) {
                            added.push(newSlot);
                        }
                        return added;
                    }, []);
                });
                return months;
            }, {}));
        });
    });
};

let diffIsEmpty = (monthSlots) => {
    let empty = true;
    Object.keys(monthSlots).forEach((month) => {
        monthSlots[month].forEach((day) => {
            day.forEach((slot) => {
                empty = false;
            })
        });
    });
    return empty;
};

let fetchSlots = (calendarURL) => {
    return new Promise((resolve, reject) => {
        fs.readFile('sessionCookie.txt','utf8', function (err, data) {
            if(err) {
                reject(err);
            }
            else {
                // Launch a request that includes the cookie in the header
                //let slotPromises;
                resolve(request({
                    uri: calendarURL,
                    method: 'GET',
                    headers: {"Cookie" : data},
                    resolveWithFullResponse: true
                }).then((response) => {
                  if (response.statusCode === 500) {
                      console.log("Authentication Failed!");
                      throw new Exception("Authentication Failed!");
                  }
                  // Check your request reaches the right page
                  const dom = new JSDOM(response.body);
                  let slots = getAvailableSlots(dom.window.document, 120, [
                    [12*60, 21*60],
                    [21*60, 21*60],
                    [21*60, 21*60],
                    [17*60, 21*60],
                    [17*60, 21*60],
                    [17*60, 21*60],
                    [12*60, 21*60],
                  ]); // "Hello world"

                  let month = {};
                  month[dom.window.document.querySelector("#tDate").selectedOptions[0].value] = slots;
                  return month;
                }).catch((err) => {
                    throw err;
                }));
            }
        });
    });
};

let printableMonths = (monthSlots) => {
    let slotText = Object.keys(monthSlots).map((month) => {
        let slots = monthSlots[month];
        return `${month}:\n` + slots.map((day, index) => {
            if (day.length === 0) {
                return '';
            }
            return `Day ${index + 1}:\n` + day.map((slot) => {
                return `${slot[0]/60} - ${slot[1]/60}\n`;
            }).join("");
        }).join("");
    }).join("\n");
    return slotText;
};


loginWithSession().then(async () => {
    let monthPromises = [
        fetchSlots('https://rfs.skymanager.com/Instructor/Info/309230'),
        fetchSlots('https://rfs.skymanager.com/Instructor/Info/309230?tDate=7%2F1%2F2019'),
        fetchSlots('https://rfs.skymanager.com/Instructor/Info/309230?tDate=8%2F1%2F2019'),
    ];
    let monthSlots = await Promise.all(monthPromises);
    monthSlots = Object.assign(...monthSlots);
    //console.log(printableMonths(await diffSlots(monthSlots)));

    let diff = await diffSlots(monthSlots);
    if (!diffIsEmpty(diff)) {
        // create reusable transport method (opens pool of SMTP connections)
        var smtpTransport = nodemailer.createTransport(smtpConfig);

        mailOptions.text = printableMonths(diff);
        // send mail with defined transport object
        let response = await smtpTransport.sendMail(mailOptions);
        console.log("Message sent: \n" + mailOptions.text);
        smtpTransport.close(); // shut down the connection pool, no more messages
    }

    fs.writeFile('slots.txt', JSON.stringify(monthSlots), function (err)
    {
        if(err)
        {
            throw err;
        }
    });
}).then(() => {console.log("Done")})
