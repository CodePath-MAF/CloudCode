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
      console.error("Got an error " + error.code + " : " + error.message);
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
        console.error("Got an error " + error.code + " : " + error.message);
      }
    });
  }
});
