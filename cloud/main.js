moment = require('cloud/moment');
_ = require('cloud/underscore-min');

/**
 * The number of milliseconds in one day
 * @type {number}
 */
MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * The parse ID for 'Bills' Category Object
 * @type {string}
 */
BILLS_CATEGORY_ID = "93BaEoZPfo";

/**
 * Debit ENUM value
 * @type {number}
 */
DEBIT_ENUM = 1;

/**
 * Credit ENUM value
 * @type {number}
 */
CREDIT_ENUM = 2;

/**
 * Goal Type ENUM values
 * @type {number}
 */
 GOAL_TYPE_LENDING_CIRCLE = 1;
 GOAL_TYPE_PERSONAL = 2;

 /**
  * Goal Status ENUM values
  */
 GOAL_STATUS_IN_PROGRESS = 1;
 GOAL_STATUS_ACHIEVED = 2;

 /**
  * Payment Interval ENUM Values
  */
 PAYMENT_INTERVAL_DAILY = 1;
 PAYMENT_INTERVAL_WEEKLY = 7;
 PAYMENT_INTERVAL_BIWEEKLY = 14;
 PAYMENT_INTERVAL_MONTHLY = 30;
 PAYMENT_INTERVAL_BIMONTHLY = 60;

logError = function(error) {
    console.error('Error: ' + JSON.stringify(error));
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

getNextPaymentDate = function(currentPaymentDate, paymentInterval) {
    var nextPaymentDate = moment(currentPaymentDate);
    switch (paymentInterval) {
        case PAYMENT_INTERVAL_DAILY:
            nextPaymentDate = nextPaymentDate.add('days', 1);
            break;
        case PAYMENT_INTERVAL_WEEKLY:
            nextPaymentDate = nextPaymentDate.add('weeks', 1);
            break;
        case PAYMENT_INTERVAL_BIWEEKLY:
            nextPaymentDate = nextPaymentDate.add('weeks', 2);
            break;
        case PAYMENT_INTERVAL_MONTHLY:
            nextPaymentDate = nextPaymentDate.add('months', 1);
            break;
        case PAYMENT_INTERVAL_BIMONTHLY:
            nextPaymentDate = nextPaymentDate.add('months', 2);
            break;
    }
    console.log('changing nextPaymentDate from: ' + currentPaymentDate + ' to: ' + nextPaymentDate.toDate());
    return nextPaymentDate.toDate();
};

/**
 * Method to run before saving the Goal
 */
Parse.Cloud.beforeSave("Goal", function(request, response) {
    var goal = request.object;
    // only calculate the number of payments if we don't have them already
    if (goal.isNew() && !goal.get('numPayments')) {
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
        goal.set('numPaymentsMade', 0);

        if (!goal.get('nextPaymentDate')) {
            goal.set('nextPaymentDate', getNextPaymentDate(today, goal.get('paymentInterval')));
        }

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

    var promises = [];
    queryUser = new Parse.Query(Parse.User);
    queryUser.get(transaction.get("user").id).then(function(user) {
        Parse.Cloud.useMasterKey();
        if (transaction.get("type") == DEBIT_ENUM) {
            // Debit transaction, increase cash
            user.increment("totalCash", transaction.get("amount"));
        } else {
            console.log("totalCash: " + user.get("totalCash"));
            // Credit transaction, decrease cash
            if (!user.get("totalCash")) {
                console.log("Empty totalCash!");
                totalCash = 0;
            } else {
                totalCash = user.get("totalCash");
            }
                totalCash = totalCash - transaction.get("amount");
                user.set("totalCash", totalCash);
        }
        return user.save();
    }, function(error) {
        console.error('Error fetching user');
        logError(error);
    }).then(function() {
        console.log("User updated successfully!");
    }, function(error) {
        console.log('Error updating user');
        logError(error);
    });
    promises.push(queryUser);

    if (transaction.get("goal")) {
        queryGoal = new Parse.Query("Goal");
        queryGoal.get(transaction.get("goal").id).then(function(goal) {
            if (transaction.get("type") == CREDIT_ENUM) {
                // Is a payment event
                goal.increment("currentTotal", transaction.get("amount"));
                goal.increment("numPaymentsMade");
                goal.set('nextPaymentDate', getNextPaymentDate(goal.get('nextPaymentDate'), goal.get('paymentInterval')));
            } else {
                // Is a cash out event
                goal.set("paidOut", true);
            }
            return goal.save();
        }, function(error) {
            console.log('Error fetching goal');
            logError(error);
        }).then(function() {
            console.log("Goal updated!");
        }, function(error) {
            console.log('Error updating goal');
            logError(error);
        });
        promises.push(queryGoal);
    }
    return Parse.Promise.when(promises);
});


/**
 * Method to run after saving the Post. will trigger notification to the
 * Lending circle group.
 */
Parse.Cloud.afterSave("Post", function(request) {
    // On successful post, broadcast a notification to the lending circle
    post = request.object;
    console.log('after save for post: ', JSON.stringify(post));

    if (!post.existed()) {
        console.log("Sending a push notification to the lending circle group after comments.");

        var params = {
            parentGoalId: post.get("goal").id,
            message: request.user.get("name") + " just posted in the lending circle!"
        };

        Parse.Cloud.run('notifyLendingCircleGroup', params);
    }
});

/**
 * Method to run after saving a Comment. Will trigger notification to the
 * Lending circle group.
 */
Parse.Cloud.afterSave('Comment', function(request) {
    comment = request.object;

    if (!comment.existed()) {
        var query = new Parse.Query('Post');
        query.equalTo('objectId', comment.get('post').id);
        query.find(function(posts) {
            // On successful post, broadcast a notification to the lending circle
            console.log("Sending a push notification to the lending circle group after comments.");
            var params = {
                parentGoalId: posts[0].get("goal").id,
                message: request.user.get("name") + " just replied to a post!"
            };
            Parse.Cloud.run('notifyLendingCircleGroup', params);
        }, function(error) {
            logError(error);
        });
        return query;
    }
});

/**
 * General Helpers
 */

createPostWithId = function(postId) {
    var Post = Parse.Object.extend('Post');
    var post = new Post();
    post.id = postId;
    return post;
};

createGoalWithId = function(goalId) {
    var Goal = Parse.Object.extend('Goal');
    var goal = new Goal();
    goal.id = goalId;
    return goal;
};

createUserWithId = function(userId) {
    var User = Parse.Object.extend('User');
    var user = new User();
    user.id = userId;
    return user;
};

getTransactions = function(user, type, internalResponse, includeCategory) {
    internalResponse = internalResponse || {};
    if (!internalResponse.transactions) {
        var query = new Parse.Query('Transaction');
        query.equalTo('user', user);
        query.equalTo('type', type);
        query.descending('transactionDate');
        if (includeCategory) {
            query.include('category');
        }
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

addUserToRequest = function(request) {
    if (!request.user) {
        if (!request.params.userId) {
            console.error('"userId" needs to be submitted in order to attach user to the request.');
            return;
        }
        request.user = createUserWithId(request.params.userId);
    }
};

addUserToRequestFetch = function(request) {
    var promise = new Parse.Promise();
    addUserToRequest(request);
    getUser(request.user.id).then(function(user) {
        request.user = user;
        promise.resolve(user);
    }, function(error) {
        promise.reject(error);
    });
    return promise;
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

getGoal = function(goalId) {
    var promise = new Parse.Promise();
    var query = new Parse.Query('Goal');
    query.get(goalId, {
        success: function(goal) {
            promise.resolve(goal);
        },
        error: function(object, error) {
            promise.reject(error);
        }
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

/**
 * Helpers for fetching the Stacked Bar Chart Detail View
 */

getTransactionsByDate = function(user, internalResponse) {
    internalResponse = internalResponse || {};
    var promise = new Parse.Promise();
    var transactionsByDate = {};
    getTransactions(user, CREDIT_ENUM, internalResponse, true).then(function(transactions) {
        _.each(transactions, function(transaction) {
            var strippedDate = getStrippedDate(transaction.get('transactionDate'));
            var transactionsForDate = transactionsByDate[strippedDate] || [];
            transactionsForDate.push(transaction);
            transactionsByDate[strippedDate] = transactionsForDate;
        });
        promise.resolve(transactionsByDate);
    });
    return promise;
};

getTotalForTransactions = function(transactions, filterFunction) {
    var total = 0;
    _.each(transactions, function(transaction) {
        if (filterFunction(transaction)) {
            total += transaction.get('amount');
        }
    });
    return total;
};

spentToday = function(today, transactions) {
    return getTotalForTransactions(transactions, function(transaction) {
        var transactionDate = moment(transaction.get('transactionDate'));
        if (
            transaction.get('type') == CREDIT_ENUM &&
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
        if (transaction.get('type') == CREDIT_ENUM && transactionDate.week() == today.week()) {
            return true;
        } else {
            return false;
        }
    });
};

transactionsTotalByCategoryByDate = function(request, internalResponse) {
    var promise = new Parse.Promise();
    internalResponse = internalResponse || {};
    getTransactions(request.user, CREDIT_ENUM, internalResponse, true).then(function(transactions) {
        var transactionsTotalByCategoryByDate = {};
        _.each(transactions, function(transaction) {
            var strippedDate = getStrippedDate(transaction.get('transactionDate'));
            var categoriesForDate = transactionsTotalByCategoryByDate[strippedDate] || {};
            var categoryName = transaction.get('category').get('name');
            var categoryTotal = categoriesForDate[categoryName] || 0;
            categoryTotal += parseFloat(transaction.get('amount'));
            categoriesForDate[categoryName] = categoryTotal;
            transactionsTotalByCategoryByDate[strippedDate] = categoriesForDate;
        });
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
        _.each(dates, function(date) {
            var dateItems = [];
            var dateTotal = 0;
            var categoriesForDate = internalResponse.transactionsTotalByCategoryByDate[date] || {};
            _.each(categories, function(category) {
                var categoryTotal = categoriesForDate[category.get('name')] || 0;
                if (categoryTotal) {
                    dateTotal += categoryTotal;
                    dateItems.push({
                        categoryName: category.get('name'),
                        categoryTotal: categoryTotal,
                        categoryColor: category.get('color')
                    });
                }
            });

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
        });

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

/**
 * Helpers for populating the goal views
 */

getPostsForGoal = function(goalId, internalResponse) {
    internalResponse = internalResponse || {};
    // fetch posts related to the goals
    var query = new Parse.Query('Post');
    query.equalTo('goal', createGoalWithId(goalId));
    query.descending('createdAt');
    query.include('comments');
    query.include('comments.user');
    query.include('user');
    return query.find().then(function(posts) {
        internalResponse.posts = posts;
        return Parse.Promise.as();
    });
};

getParentGoalDetailView = function(request, internalResponse) {
    internalResponse = internalResponse || {};
    // fetch the parent goal
    var query = new Parse.Query('Goal');
    query.equalTo('objectId', request.params.parentGoalId);
    return query.find().then(function(results) {
        // fetch the child goals
        var parentGoal = results[0];
        internalResponse.parentGoal = parentGoal;
        var childQuery = new Parse.Query('Goal');
        childQuery.equalTo('parentGoal', parentGoal);
        childQuery.include('user');
        childQuery.ascending('cashOutDate');
        return childQuery.find();
    }).then(function(results) {
        // collect child goal data
        var userGoal,
            cashOutSchedule = [],
            currentCashOutUserName = '';

        _.each(results, function(goal) {
            // XXX alternatively this could be goalId
            if (goal.get('user').id == request.user.id) {
                userGoal = goal;
            }
            if (currentCashOutUserName === '' && !goal.get('paidOut')) {
                currentCashOutUserName = goal.get('user').get('name');
            }
            cashOutSchedule.push({
                userId: goal.get('user').id,
                paidOut: goal.get('paidOut'),
                profileImageId: goal.get('user').get('profileImageId')
            });
        });
        internalResponse.cashOutSchedule = cashOutSchedule;
        internalResponse.userGoal = userGoal;
        internalResponse.currentCashOutUserName = currentCashOutUserName;
        return Parse.Promise.as();
    }).then(function() {
        return getPostsForGoal(request.params.parentGoalId, internalResponse);
    }).then(function() {
        internalResponse.goalDetails = {
            currentCashOutUserName: internalResponse.currentCashOutUserName,
            cashOutSchedule: internalResponse.cashOutSchedule,
            isLendingCircle: true
        };
        return Parse.Promise.as();
    });
};

getGoalDetailView = function(request, internalResponse) {
    internalResponse = internalResponse || {};
    var query = new Parse.Query('Goal');
    query.equalTo('objectId', request.params.goalId);
    return query.find().then(function(results) {
        internalResponse.userGoal = results[0];
        return Parse.Promise();
    }).then(function() {
        return getPostsForGoal(request.params.goalId, internalResponse);
    }).then(function() {
        internalResponse.goalDetails = {
            isLendingCircle: false
        };
        return Parse.Promise.as();
    });
};

/**
 * Helpers for creating lending circles
 */

createParentGoal = function(request, internalResponse) {
    internalResponse = internalResponse || {};
    var Goal = Parse.Object.extend('Goal');
    var goal = new Goal();
    users = _.map(request.params.users, function(userId) {
        return createUserWithId(userId);
    });
    goal.set('users', users);
    goal.set('name', request.params.name);
    goal.set('type', GOAL_TYPE_LENDING_CIRCLE);
    goal.set('status', GOAL_STATUS_IN_PROGRESS);
    goal.set('amount', request.params.users.length * request.params.paymentAmount);
    goal.set('paymentAmount', parseFloat(request.params.paymentAmount));
    goal.set('numPayments', request.params.users.length);
    return goal.save();
};

/**
 * Cloud Functions
 */

/**
 * Get the information needed to render the Goal Detail View
 * @param {string} goalId The Goal ID you want the details for
 * @param {string} parentGoalId The goal's parent id if available
 * @param {string} userId The User ID of the user making the request
 */
Parse.Cloud.define('goalDetailView', function(request, response) {
    var internalResponse = {};
    addUserToRequest(request);
    if (request.params.parentGoalId) {
        goalDetails = getParentGoalDetailView(request, internalResponse);
    } else {
        goalDetails = getGoalDetailView(request, internalResponse);
    }

    goalDetails.then(function() {
        response.success({
            goal: internalResponse.userGoal,
            goalDetails: internalResponse.goalDetails,
            posts: internalResponse.posts
        });
    });

});

/**
 * Get the information needed to render the Stacked Bar Chart Detail View
 * @param {string} userId User ID making the request
 * @param {date} today Date representing today's date
 * @param {number} year Year of the latest transaction you want to display
 * @param {number} month Month of the latest transaction you want to display
 * @param {number} day Day of the latest transaction you want to display
 */
Parse.Cloud.define('stackedBarChartDetailView', function(request, response) {
    var internalResponse = {};
    getUser(request.params.userId).then(function(user) {
        request.user = user;
        return stackedBarChart(request, internalResponse);
    }).then(function() {
        return getTransactionsByDate(request.user, internalResponse);
    }).then(function(transactionsByDate) {
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

/**
 * Create a lending circle for a list of users
 * @param {list} users List of users in the lending circle (should be ordered by date they're going to get cashed out)
 * @param {number} year Year of the first cash out date
 * @param {number} month Month of the first cash out date
 * @param {number} day Day of the first cash out date
 * @param {string} name Name of the lending circle
 * @param {string} paymentAmount Amount of the monthly payments
 */
Parse.Cloud.define('createLendingCircle', function(request, response) {
    var internalResponse = {};
    var firstPayment = moment([request.params.year, request.params.month - 1, request.params.day]);
    var goalDate = moment([request.params.year, request.params.month -1, request.params.day]).add('months', request.params.users.length).toDate();
    createParentGoal(request, internalResponse).then(function(parentGoal) {
        internalResponse.parentGoal = parentGoal;
        var goals = [];
        var Goal = Parse.Object.extend('Goal');
        var nextCashOutIncrement = 0;
        _.each(request.params.users, function(userId) {
            var goal = new Goal();
            var nextCashOut = moment([request.params.year, request.params.month - 1, 20]).add('months', nextCashOutIncrement);
            goal.set('user', createUserWithId(userId));
            goal.set('name', parentGoal.get('name'));
            goal.set('type', parentGoal.get('type'));
            goal.set('status', parentGoal.get('status'));
            goal.set('amount', parentGoal.get('amount'));
            goal.set('paymentAmount', parentGoal.get('paymentAmount'));
            goal.set('numPayments', parentGoal.get('numPayments'));
            goal.set('numPaymentsMade', 0);
            goal.set('currentTotal', 0);
            goal.set('parentGoal', parentGoal);
            goal.set('cashOutDate', nextCashOut.toDate());
            goal.set('paidOut', false);
            goal.set('nextPaymentDate', firstPayment.toDate());
            goal.set('paymentInterval', PAYMENT_INTERVAL_MONTHLY);
            goal.set('goalDate', goalDate);
            goals.push(goal);
            nextCashOutIncrement += 1;
        });
        return Parse.Object.saveAll(goals);
    }).then(function(goals) {
        response.success({
            parentGoal: internalResponse.parentGoal,
            userGoals: goals
        });
    }, function(error) {
        logError(error);
        response.error();
    });
});

/**
 * Create a post
 * @param {string} userId User ID of the user making the post
 * @param {string} goalId Goal ID the post is related to
 * @param {string} content Content of the post
 * @param {number} type Type of post
 * @param {string} toUserId The user id of the recipient (only applicable for private posts)
 */
Parse.Cloud.define('createPost', function(request, response) {
    var Post = Parse.Object.extend('Post');
    var post = new Post();
    addUserToRequest(request);
    post.set('user', request.user);
    post.set('goal', createGoalWithId(request.params.goalId));
    post.set('content', request.params.content);
    post.set('type', request.params.type);
    if (request.params.toUserId) {
        post.set('toUser', request.params.toUserId);
    }
    post.save().then(function(post) {
        response.success({
            success: true,
            post: post,
        });
    }, function(error) {
        logError(error);
        response.error();
    });
});

/**
 * Create a comment for a post
 * @param {string} postId The post the comment is associated with
 * @param {string} userId The user posting the comment
 * @param {string} content The contents of the commment
 */
Parse.Cloud.define('createComment', function(request, response) {
    var Comment = Parse.Object.extend('Comment');
    var comment = new Comment();
    var post = createPostWithId(request.params.postId);
    addUserToRequest(request);
    comment.set('user', request.user);
    comment.set('post', post);
    comment.set('content', request.params.content);
    post.add('comments', comment);
    post.save().then(function(post) {
        response.success({
            success: true,
            comment: post,
        });
    });
});

/**
 * Fetch the data for the stacked bar chart.
 * This will return the following structure:
 * {
 *      'maxValue': <maximum total amongst all the dates>,
 *      'xLabels': <list of date strings to display as the xLabels>
 *      'data': <list of arrays which represent data points for each bar>
 *  }
 * @param {string} userId User ID making the request
 * @param {number} year Year of the latest transaction you want to display
 * @param {number} month Month of the latest transaction you want to display
 * @param {number} day Day of the latest transaction you want to display
 */
Parse.Cloud.define('stackedBarChart', function(request, response) {
    var internalResponse = {};
    addUserToRequest(request);
    stackedBarChart(request, internalResponse).then(function() {
        response.success(internalResponse.stackedBarChart);
    });
});

/**
 * Method to record user payment
 * @param {string} request.params.userId
 * @param {string} request.params.goalId
 * @return response.success or response.error
 */
Parse.Cloud.define("recordPayment", function(request, response) {
    addUserToRequest(request);
    getGoal(request.params.goalId).then(function(goal) {
        var Transaction = Parse.Object.extend("Transaction");
        var transaction = new Transaction();

        // Category
        var Category = Parse.Object.extend("Category");
        var category = new Category();
        category.id = BILLS_CATEGORY_ID;

        transaction.set("user", request.user);
        transaction.set("amount", goal.get("paymentAmount"));
        transaction.set("name", "Lending circle Payment");
        transaction.set("goal", goal);
        transaction.set("transactionDate", new Date());
        transaction.set("type", CREDIT_ENUM); // CREDIT
        transaction.set("category", category);
        return transaction.save();
    }).then(function(transaction) {
        // the save succeed, lets send a push notification to the user
        var query = new Parse.Query(Parse.Installation);
        query.equalTo('user', request.user);

        console.log("Trying to send a push notification...");
        Parse.Push.send({
          where: query, // Set our Installation query
          data: {
            alert: "Payment received."
          }
        }, {
          success: function() {
            // Push was successful
            console.log("Push notification sent!");
          },
          error: function(error) {
            // Handle error
            console.error("Push notification failed");
            logError(error);
          }
        });

        // Response will be sent regardless push outcome
        response.success();
    }, function(error) {
        // The save failed
        response.error("Oops! error recording payment.");
    });
});

/**
 * Method to record cash out event
 * @param {string} request.params.userId
 * @param {string} request.params.goalId
 * @return response.success or response.error
 */
Parse.Cloud.define("recordCashOut", function(request, response) {
    addUserToRequest(request);
    getGoal(request.params.goalId).then(function(goal) {
        if (!goal.get("paidOut")) {
            var Transaction = Parse.Object.extend("Transaction");
            var transaction = new Transaction();

            // Category
            var Category = Parse.Object.extend("Category");
            var category = new Category();
            category.id = BILLS_CATEGORY_ID;

            transaction.set("user", request.user);
            transaction.set("amount", goal.get("amount"));
            transaction.set("name", "Lending circle Cash Out");
            transaction.set("goal", goal);
            transaction.set("transactionDate", new Date());
            transaction.set("type", DEBIT_ENUM); // DEBIT
            transaction.set("category", category);
            return transaction.save();
        } else {
            return Parse.Promise.error("the goal for the user had already being cashed out.");
        }
    }).then(function(transaction) {
        // the save succeed, lets send a push notification to the user

        var query = new Parse.Query(Parse.Installation);
        query.equalTo('user', request.user);

        console.log("Trying to send a push notification...");
        Parse.Push.send({
          where: query, // Set our Installation query
          data: {
            alert: "Lending Circle loan successfully added to your account"
          }
        }, {
          success: function() {
            // Push was successful
            console.log("Push notification sent!");
          },
          error: function(error) {
            // Handle error
            console.error("Push notification failed");
            logError(error);
          }
        });

        // Response will be sent regardless push outcome
        response.success();
    }, function(error) {
        // The save failed
        response.error("Oops! error recording a cash out. " + error);
    });
});

/**
 * Fetch the data for the main dashboard view
 * @param {string} request.params.userId
 */
Parse.Cloud.define('dashboardView', function(request, response) {
    var internalResponse = {};
    addUserToRequestFetch(request).then(function() {
        return getTransactions(request.user, CREDIT_ENUM, internalResponse).then(function(transactions) {
            internalResponse.xLabels = [];
            internalResponse.chartData = [];
            internalResponse.transactionsTotalByWeek = {};
            _.each(transactions, function(transaction) {
                var week = moment(transaction.get('transactionDate')).endOf('week').format('MMM D');
                if (_.indexOf(internalResponse.xLabels, week) === -1) {
                    // want the later dates to be at the end of the list
                    internalResponse.xLabels.unshift(week);
                }
                totalByWeek = internalResponse.transactionsTotalByWeek[week] || 0;
                totalByWeek += transaction.get('amount');
                internalResponse.transactionsTotalByWeek[week] = totalByWeek;
            });
            _.each(internalResponse.xLabels, function(week) {
                internalResponse.chartData.push(internalResponse.transactionsTotalByWeek[week]);
            });
            return Parse.Promise.as();
        });
    }).then(function() {
        var query = new Parse.Query('Goal');
        query.equalTo('user', request.user);
        return query.find();
    }).then(function(goals) {
        internalResponse.goalToPrettyDueDate = {};
        internalResponse.goals = goals;
        internalResponse.goals = _.each(goals, function(goal) {
            internalResponse.goalToPrettyDueDate[goal.id] = {
                prettyDate: moment(goal.get('nextPaymentDate')).fromNow(),
                warning: moment(goal.get('nextPaymentDate')).diff(new Date(), 'days') <= 7 ? true : false
            };
        });
        return Parse.Promise.as();
    }).then(function() {
        response.success({
            lineChart: {
                data: internalResponse.chartData,
                xLabels: internalResponse.xLabels
            },
            goals: internalResponse.goals,
            goalToPrettyDueDate: internalResponse.goalToPrettyDueDate,
            totalCash: request.user.get('totalCash')
        });
    });
});

/**
 * Broadcast a message to all users participating on the Lending Circle
 *
 * @param {string} parentGoalId Parent Goal ID to broadcast message to
 * @param {string} message Message to broadcast
 */
Parse.Cloud.define('notifyLendingCircleGroup', function(request, response) {
    // get all users participating on the goal
    var queryGoal = new Parse.Query('Goal');
    queryGoal.include("users");
    queryGoal.get(request.params.parentGoalId).then(function(goal) {
        return goal.get("users");
    }).then(function(users) {
        console.log("users: " + users)
        // query all app installations containing those users id
        var query = new Parse.Query(Parse.Installation);
        query.containedIn('user', users);

        // send out the message with push.send
        console.log("Trying to send a push notification...");
        return Parse.Push.send({
                  where: query, // Set our Installation query
                  data: {
                    alert: request.params.message
                  }
                });
    }).then(function() {
        // push notification succeed
        response.success();
    }, function(error) {
        // push notifications failed
        response.error("Oops! error sending push notifications. e: " + error);
    });
});
