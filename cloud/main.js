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
}

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
getTransactions = function(user) {
    var query = new Parse.Query('Transaction');
    query.equalTo('user', user);
    // XXX potentially take an argument to see if we need to include the category
    query.include('category');
    return query.find();
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
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

getLastSevenDays = function(year, month, day) {
    var dates = [];
    for (i = 0; i < 7; i++) {
        dates.push(new Date(year, month - 1, day - i));
    }
    return dates;
};

//transactionsTotalByDate = function(request, internalResponse, callback) {
    //var internalResponse = internalResponse || {};
    //getTransactions(request.user, function(error, transactions) {
        //if (error) {
            //callback(error);
        //} else {
            //var totalByDate = {};
            //for (i = 0; i < transactions.length; i++) {
                //var transaction = transactions[i];
                //var strippedDate = getStrippedDate(transaction.get('transactionDate'));
                //var total = totalByDate[strippedDate] ? totalByDate[strippedDate] : 0;
                //totalByDate[strippedDate] = total + parseFloat(transaction.get('amount'));
            //}
            //internalResponse.totalByDate = totalByDate;
            //callback(null, internalResponse);
        //}
    //});
//}

//Parse.Cloud.define('transactionsTotalByDate', function(request, response) {
    //var query = new Parse.Query('User');
    //query.equalTo('objectId', request.params.userId);
    //query.find({
        //success: function(user) {
            //request.user = user;
            //transactionsTotalByDate(user[0], request, function(error, internalResponse) {
                //if (error) {
                    //logErorr(error);
                //} else {
                    //response.success(internalResponse);
                //}
            //});
        //},
        //error: function() {
            //logError(error);
        //}
    //});
//});

transactionsTotalByCategoryByDate = function(request, internalResponse) {
    var promise = new Parse.Promise();
    internalResponse = internalResponse || {};
    getTransactions(request.user).then(function(transactions) {
        var transactionsTotalByCategoryByDate = {};
        for (i = 0; i < transactions.length; i++) {
            var transaction = transactions[i];
            // TODO correct this logic, on iOS we treated transaction type 1 as an expense
            if (transaction.get('type') == 1) {
                var strippedDate = getStrippedDate(transaction.get('transactionDate'));
                var categoriesForDate = transactionsTotalByCategoryByDate[strippedDate] || {};
                var categoryName = transaction.get('category').get('name');
                var categoryTotal = categoriesForDate[categoryName] || 0;
                categoryTotal += parseFloat(transaction.get('amount'));
                categoriesForDate[categoryName] = categoryTotal;
                transactionsTotalByCategoryByDate[strippedDate] = categoriesForDate;
            }
        }
        internalResponse.transactionsTotalByCategoryByDate = transactionsTotalByCategoryByDate;
        promise.resolve(internalResponse);
    }, function(error) {
        logError(error);
        promise.reject(error);
    });
    return promise;
};

Parse.Cloud.define('transactionsTotalByCategoryByDate', function(request, response) {
    var internalResponse = {};
    getUser(request.params.userId).then(function(user) {
        request.user = user;
        return transactionsTotalByCategoryByDate(request, internalResponse);
    }).then(function() {
        response.success(internalResponse);
    }, function(error) {
        handleError(error);
    });
});

// Fetch the data for the stacked bar chart. This will return the following structure:
// {
//      'maxValue': <maximum total amongst all the dates>,
//      'xLabels': <list of date strings to display as the xLabels>
//      'data': <list of arrays which represent data points for each bar>
//  }
Parse.Cloud.define('stackedBarChart', function(request, response) {
    var internalResponse = {};
    var maxValue = 0;
    var hasData = false;
    getUser(request.params.userId).then(function(user) {
        request.user = user;
        return transactionsTotalByCategoryByDate(request, internalResponse);
    }).then(function() {
        return getCategories();
    }).then(function(categories) {
        var dates = getLastSevenDays(request.params.year, request.params.month, request.params.day);
        var xLabels = [];
        var data = [];
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
            if (dateTotal > maxValue) {
                if (!hasData) {
                    hasData = true;
                }
                maxValue = dateTotal;
            }
            data.unshift(dateItems);
            xLabels.unshift(date);
        }
        response.success({
            maxValue: maxValue,
            data: data,
            xLabels: xLabels,
            hasData: hasData,
        });
    });
});
