#!/bin/bash
set -euo pipefail

STACK_NAME="mission-control"
REGION="${AWS_REGION:-eu-west-2}"
PROFILE="${AWS_PROFILE:-jessian}"

echo "── Building Lambda dependencies ──"
cd backend/revenue && npm install && cd ../..
cd backend/players && npm install && cd ../..
cd backend/messages && npm install && cd ../..

echo "── SAM Build ──"
sam build

echo "── SAM Deploy ──"
sam deploy \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset

echo "── Getting outputs ──"
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendBucket'].OutputValue" \
  --output text)

CF_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontUrl'].OutputValue" \
  --output text)

echo "── Deploying frontend to S3 ──"
aws s3 sync frontend/ "s3://$BUCKET/" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --delete

echo ""
echo "✅ Deployed to: $CF_URL"
