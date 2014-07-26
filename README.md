#Parse Cloud Code

Share Cloud Code functions used on both iOS and Android Apps.

## Setup Instructions
* **Clone the repository**

`git clone https://github.com/CodePath-MAF/CloudCode.git`

* **Create the config file**

Create `config/global.json` and add in the Parse Application & Client ID for the project following this sample:

```json
{
    "applications": {
        "CodePath - MAF": {
            "applicationId": "PARSE_APPLICATION_ID",
            "masterKey": "PARSE_MASTER_KEY"
        },
        "_default": {
            "link": "CodePath - MAF"
        }
    }
}
```

**Note:** This config file will be gitginore.
