FROM mcr.microsoft.com/azure-functions/node:4-node18

RUN apt-get update && apt-get install -y qpdf && rm -rf /var/lib/apt/lists/*

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true

COPY . /home/site/wwwroot
RUN cd /home/site/wwwroot && npm install --production