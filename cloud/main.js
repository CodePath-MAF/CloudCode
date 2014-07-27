logError = function(error) {
    console.error('Got an error ' + error.code + ' : ' + error.message);
}

handleError = function(error) {
    logError(error);
    return Parse.Promise.Error(error);
}

// Updating User & Goal object after a Transaction save operation
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
        user.set("totalCash", totalCash - transaction.get("amount"))
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
    var promise = new Parse.Promise()
    console.log('fetching transactions ' + JSON.stringify(user));
    var query = new Parse.Query('Transaction');
    query.equalTo('user', user);
    // XXX potentially take an argument to see if we need to include the category
    query.include('category');
    return query.find();
}

getStrippedDate = function(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

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
    var internalResponse = internalResponse || {};
    getTransactions(request.user).then(function(transactions) {
        var transactionsByCategoryByDate = {};
        for (i = 0; i < transactions.length; i++) {
            var transaction = transactions[i];
            // TODO correct this logic, on iOS we treated transaction type 1 as an expense
            if (transaction.get('type') == 1) {
                var strippedDate = getStrippedDate(transaction.get('transactionDate'));
                var categoriesForDate = transactionsByCategoryByDate[strippedDate] ? transactionsByCategoryByDate[strippedDate] : {};
                var categoryName = transaction.get('category').get('name');
                var categoryTotal = categoriesForDate[categoryName] ? categoriesForDate[categoryName] : 0;
                categoryTotal += parseFloat(transaction.get('amount'));
                categoriesForDate[categoryName] = categoryTotal;
                transactionsByCategoryByDate[strippedDate] = categoriesForDate;
            }
        }
        internalResponse.transactionsByCategoryByDate = transactionsByCategoryByDate;
        promise.resolve(internalResponse);
    }, function(error) {
        logError(error);
        promise.reject(error);
    });
    return promise;
};

Parse.Cloud.define('transactionsTotalByCategoryByDate', function(request, response) {
    var internalResponse = {};
    var query = new Parse.Query('User');
    query.equalTo('objectId', request.params.userId);
    query.find().then(function(users) {
        request.user = users[0];
        return transactionsTotalByCategoryByDate(request, internalResponse);
    }).then(function() {
        response.success(internalResponse);
    }, function(error) {
        handleError(error);
    });
});
