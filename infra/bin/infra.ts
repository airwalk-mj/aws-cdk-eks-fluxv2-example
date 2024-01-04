#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { InfraStack } from '../lib/infra-stack';

const app = new App();
new InfraStack(app, 'GREEN-InfraStack', {
    env: { 
        account: process.env.CDK_DEPLOY_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT, 
        region: process.env.CDK_DEPLOY_REGION || process.env.CDK_DEFAULT_REGION 
    }
});
