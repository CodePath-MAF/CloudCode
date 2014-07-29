moment = require('cloud/moment');

/**
 * The number of milliseconds in one day
 * @type {number}
 */
MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

logError = function(error) {
    console.error('Got an error ' + error.code + ' : ' + error.message);
};

handleError = function(error) {
    logError(error);
    return Parse.Promise.Error(error);
};

/**
 * Calculate days between two dates
 * @param {date} startDate
 * @param {date} endDate
 * @return {number} Number of days in between
 */
daysBetween = function(startDate, endDate) {
    return Math.floor((endDate - startDate) / MILLISECONDS_PER_DAY);
};

/**
 * Method to run before saving the Goal
 */
Parse.Cloud.beforeSave("Goal", function(request, response) {
    var goal = request.object;
    if (goal.isNew()) {
        var today = new Date();
        var daysInBetween = daysBetween(today, goal.get("goalDate"));
        var numPayments = Math.floor(daysInBetween / goal.get('paymentInterval'));
        var paymentAmount = goal.get('amount') / numPayments;
        console.log('today: ' + today + ' daysInBetween: ' + daysInBetween + ' numPayments: ' + numPayments + ' paymentAmount' + paymentAmount);

        if (numPayments < 1) {
            // Date selected is shorter than a successful first payment base on
            // the payment interval
            // TODO: improve error message
            response.error("Date selected shorter than initial payment interval");
            return;
        }

        goal.set("numPayments", numPayments);
        goal.set("paymentAmount", paymentAmount);
        goal.set("currentTotal", 0);

        request.object = goal;
    }
    response.success();
});

/**
 * Method to run after saving the Transaction. Will update User & Goal object
 * accordingly.
 */
Parse.Cloud.afterSave("Transaction", function(request) {
  transaction = request.object;

  queryUser = new Parse.Query(Parse.User);
  queryUser.get(transaction.get("user").id, {
    success: function(user) {
      if (transaction.get("type") == 1) {
        // Debit transaction, increase cash
        user.increment("totalCash", transaction.get("amount"));
      } else {
        // Credit transaction, decrease cash
        if (!user.get("totalCash")) {
          totalCash = 0;
        } else {
          totalCash = user.get("totalCash");
        }
        user.set("totalCash", totalCash - transaction.get("amount"));
      }
      user.save();
      console.log("User updated!");
    },
    error: function(error) {
        logError(error);
    }
  });

  if (transaction.get("goal")) {
    queryGoal = new Parse.Query("Goal");
    queryGoal.get(transaction.get("goal").id, {
      success: function(goal) {
        goal.increment("currentTotal", transaction.get("amount"));
        goal.save();
        console.log("Goal updated!");
      },
      error: function(error) {
          logError(error);
      }
    });
  }
});

// Transaction Helper Functions
getTransactions = function(user, type, internalResponse) {
    internalResponse = internalResponse || {};
    if (!internalResponse.transactions) {
        var query = new Parse.Query('Transaction');
        query.equalTo('user', user);
        query.equalTo('type', type);
        query.descending('transactionDate');
        // XXX potentially take an argument to see if we need to include the category
        query.include('category');
        return query.find().then(function(transactions) {
            internalResponse.transactions = transactions;
            return Parse.Promise.as(transactions);
        });
    } else {
        return Parse.Promise.as(internalResponse.transactions);
    }
};

getCategories = function() {
    var query = new Parse.Query('Category');
    return query.find();
};

getUser = function(userId) {
    var promise = new Parse.Promise();
    var query = new Parse.Query('User');
    query.equalTo('objectId', userId);
    query.find().then(function(results) {
        promise.resolve(results[0]);
    }, function(error) {
        promise.reject(error);
    });
    return promise;
};

getStrippedDate = function(date) {
    return moment(new Date(date.getFullYear(), date.getMonth(), date.getDate())).format('YYYY-MM-DD');
};

getLastSevenDays = function(year, month, day) {
    var dates = [];
    for (i = 0; i < 7; i++) {
        dates.push(moment(new Date(year, month - 1, day - i)).format('YYYY-MM-DD'));
    }
    return dates;
};

getTransactionsByDate = function(user, internalResponse) {
    internalResponse = internalResponse || {};
    var promise = new Parse.Promise();
    var transactionsByDate = {};
    getTransactions(user, 2, internalResponse).then(function(transactions) {
        for (i = 0; i < transactions.length; i++) {
            var transaction = transactions[i];
            var strippedDate = getStrippedDate(transaction.get('transactionDate'));
            var transactionsForDate = transactionsByDate[strippedDate] || [];
            transactionsForDate.push(transaction);
            transactionsByDate[strippedDate] = transactionsForDate;
        }
        promise.resolve(transactionsByDate);
    });
    return promise;
};

getTotalForTransactions = function(transactions, filterFunction) {
    var total = 0;
    for (i = 0; i < transactions.length; i++) {
        var transaction = transactions[i];
        if (filterFunction(transaction)) {
            total += transaction.get('amount');
        }
    }
    return total;
};

spentToday = function(today, transactions) {
    return getTotalForTransactions(transactions, function(transaction) {
        var transactionDate = moment(transaction.get('transactionDate'));
        if (
            transaction.get('type') == 2 &&
            transactionDate.year() == today.year() &&
            transactionDate.month() == today.month() &&
            transactionDate.date() == today.date()
        ) {
            return true;
        } else {
            return false;
        }
    });
};

spentThisWeek = function(today, transactions) {
    return getTotalForTransactions(transactions, function(transaction) {
        var transactionDate = moment(transaction.get('transactionDate'));
        if (transaction.get('type') == 2 && transactionDate.week() == today.week()) {
            return true;
        } else {
            return false;
        }
    });
};

transactionsTotalByCategoryByDate = function(request, internalResponse) {
    var promise = new Parse.Promise();
    internalResponse = internalResponse || {};
    // type 2 is credit transactions
    getTransactions(request.user, 2, internalResponse).then(function(transactions) {
        var transactionsTotalByCategoryByDate = {};
        for (i = 0; i < transactions.length; i++) {
            var transaction = transactions[i];
            var strippedDate = getStrippedDate(transaction.get('transactionDate'));
            var categoriesForDate = transactionsTotalByCategoryByDate[strippedDate] || {};
            var categoryName = transaction.get('category').get('name');
            var categoryTotal = categoriesForDate[categoryName] || 0;
            categoryTotal += parseFloat(transaction.get('amount'));
            categoriesForDate[categoryName] = categoryTotal;
            transactionsTotalByCategoryByDate[strippedDate] = categoriesForDate;
        }
        internalResponse.transactionsTotalByCategoryByDate = transactionsTotalByCategoryByDate;
        promise.resolve(internalResponse);
    }, function(error) {
        logError(error);
        promise.reject(error);
    });
    return promise;
};

stackedBarChart = function(request, internalResponse) {
    var promise = new Parse.Promise();
    internalResponse = internalResponse || {};
    transactionsTotalByCategoryByDate(request, internalResponse).then(function() {
        return getCategories();
    }).then(function(categories) {
        var maxValue = 0;
        var hasData = false;
        var dates = getLastSevenDays(request.params.year, request.params.month, request.params.day);
        var xLabels = [];
        var data = [];
        internalResponse.dates = [];
        for (i = 0; i < dates.length; i++) {
            var date = dates[i];
            var dateItems = [];
            var dateTotal = 0;
            var categoriesForDate = internalResponse.transactionsTotalByCategoryByDate[date] || {};
            for (j = 0; j < categories.length; j++) {
                var category = categories[j];
                var categoryTotal = categoriesForDate[category.get('name')] || 0;
                if (categoryTotal) {
                    dateTotal += categoryTotal;
                    dateItems.push({
                        categoryName: category.get('name'),
                        categoryTotal: categoryTotal,
                        categoryColor: category.get('color')
                    });
                }
            }

            if (dateTotal) {
                internalResponse.dates.push(date);
            }

            if (dateTotal > maxValue) {
                if (!hasData) {
                    hasData = true;
                }
                maxValue = dateTotal;
            }
            data.unshift(dateItems);
            xLabels.unshift(moment(date).format('ddd'));
        }
        internalResponse.stackedBarChart = {
            maxValue: maxValue,
            data: data,
            xLabels: xLabels,
            hasData: hasData,
        };
        promise.resolve(internalResponse);
    });
    return promise;
};

// Fetch the data for the stacked bar chart. This will return the following structure:
// {
//      'maxValue': <maximum total amongst all the dates>,
//      'xLabels': <list of date strings to display as the xLabels>
//      'data': <list of arrays which represent data points for each bar>
//  }
Parse.Cloud.define('stackedBarChart', function(request, response) {
    var internalResponse = {};
    getUser(request.params.userId).then(function(user) {
        request.user = user;
        return stackedBarChart(request, internalResponse);
    }).then(function() {
        response.success(internalResponse.stackedBarChart);
    });
});

Parse.Cloud.define('stackedBarChartDetailView', function(request, response) {
    var internalResponse = {};
    getUser(request.params.userId).then(function(user) {
        request.user = user;
        return stackedBarChart(request, internalResponse);
    }).then(function() {
        return getTransactionsByDate(request.user, internalResponse);
    }).then(function(transactionsByDate) {
        console.log('transactionsByDate: ' + JSON.stringify(transactionsByDate));
        response.success({
            transactionsByDate: transactionsByDate,
            stackedBarChart: internalResponse.stackedBarChart,
            dates: internalResponse.dates,
            spentThisWeek: spentThisWeek(moment(request.params.today), internalResponse.transactions),
            spentToday: spentToday(moment(request.params.today), internalResponse.transactions),
            totalCash: request.user.get('totalCash')
        });
    });
});


transactionsTotalByDate = function(request, internalResponse) {
    var promise = new Parse.Promise();
    internalResponse = internalResponse || {};
    // type 2 is credit transactions
    getTransactions(request.user, 2, internalResponse).then(function(transactions) {
        var transactionsTotalByDate = {};
        for (i = 0; i < transactions.length; i++) {
            var transaction = transactions[i];
            var strippedDate = getStrippedDate(transaction.get('transactionDate'));
            var amountForDate = transactionsTotalByDate[strippedDate] || 0;
            amountForDate += parseFloat(transaction.get('amount'));
            transactionsTotalByDate[strippedDate] = amountForDate;
        }
        internalResponse.transactionsTotalByDate = transactionsTotalByDate;
        promise.resolve(internalResponse);
    }, function(error) {
        logError(error);
        promise.reject(error);
    });
    return promise;
};


// Create data for lineChart
lineChart = function(request, internalResponse) {
    var promise = new Parse.Promise();
    internalResponse = internalResponse || {};
    transactionsTotalByDate(request, internalResponse).then(function() {
        var maxValue = 0;
        var hasData = false;
        var dates = getLastSevenDays(request.params.year, request.params.month, request.params.day);
        var xLabels = [];
        var data = [];
        internalResponse.dates = [];
        for (i = 0; i < dates.length; i++) {
            var date = dates[i];
            var amountForDate = internalResponse.transactionsTotalByDate[date] || 0;

            if (amountForDate) {
                internalResponse.dates.push(date);
            }

            if (amountForDate > maxValue) {
                if (!hasData) {
                    hasData = true;
                }
                maxValue = amountForDate;
            }

            data.unshift(amountForDate);
            xLabels.unshift(moment(date).format('ddd'));
        }

        internalResponse.lineChart = {
            maxValue: maxValue,
            data: data,
            xLabels: xLabels,
            hasData: hasData,
        };
        
        promise.resolve(internalResponse);
    });
    return promise;
};

// Line Chart
// Fetch data for the line chart over stacked bar chart. 
// I wonder if we really need this. It wil be just some of all category expenses. Isn't it? 
// Either way, 
// This will return the following structure:
// {
//      'maxValue': <maximum total amongst all the dates>,
//      'xLabels': <list of date strings to display as the xLabels>
//      'data': < array with amount for earch day>
//  }
Parse.Cloud.define('lineChart', function(request, response) {
    var internalResponse = {};
    getUser(request.params.userId).then(function(user) {
        request.user = user;
        return lineChart(request, internalResponse);
    }).then(function() {
        response.success(internalResponse.lineChart);
    });
});
