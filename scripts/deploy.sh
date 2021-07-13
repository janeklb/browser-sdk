#!/usr/bin/env bash

set -ex

env=$1
suffix=$2

USAGE="Usage: ./deploy.sh staging|prod head|canary|vXXX"

case "${env}" in
"prod")
    AWS_ACCOUNT_ID=464622532012
    BUCKET_NAME="browser-agent-artifacts-prod"
    DISTRIBUTION_ID="EGB08BYCT1DD9"
    ;;
"staging")
    AWS_ACCOUNT_ID=727006795293
    BUCKET_NAME="browser-agent-artifacts-staging"
    DISTRIBUTION_ID="E2FP11ZSCFD3EU"
    ;;
* )
    echo $USAGE
    exit 1
    ;;
esac

case "${suffix}" in
v[0-9]*) # if major version also update legacy files
    declare -A BUNDLES=(
      ["datadog-rum-${suffix}.js"]="packages/rum/bundle/datadog-rum.js"
      ["datadog-rum-recorder-${suffix}.js"]="packages/rum-recorder/bundle/datadog-rum-recorder.js"
      ["datadog-rum.js"]="packages/rum/bundle/datadog-rum.js" # deprecated: to remove with version 3
      ["datadog-rum-recorder.js"]="packages/rum-recorder/bundle/datadog-rum-recorder.js" # deprecated: to remove with version 3
      ["datadog-rum-eu.js"]="packages/rum/bundle/datadog-rum-eu.js" # deprecated: to remove with version 3
      ["datadog-rum-us.js"]="packages/rum/bundle/datadog-rum-us.js" # deprecated: to remove with version 3
      ["datadog-logs.js"]="packages/logs/bundle/datadog-logs.js"
      ["datadog-logs-eu.js"]="packages/logs/bundle/datadog-logs-eu.js"
      ["datadog-logs-us.js"]="packages/logs/bundle/datadog-logs-us.js" 
    )
    CACHE_CONTROL='max-age=14400, s-maxage=60'
  ;;
"canary" | "head")
    declare -A BUNDLES=(
      ["datadog-logs-${suffix}.js"]="packages/logs/bundle/datadog-logs.js"
      ["datadog-rum-${suffix}.js"]="packages/rum/bundle/datadog-rum.js"
      ["datadog-rum-recorder-${suffix}.js"]="packages/rum-recorder/bundle/datadog-rum-recorder.js"
    )
    CACHE_CONTROL='max-age=900, s-maxage=60'
  ;;
* )
    echo $USAGE
    exit 1
  ;;
esac

main() {
  in-isolation upload-to-s3
  in-isolation invalidate-cloudfront
}

upload-to-s3() {
    assume-role "build-stable-browser-agent-artifacts-s3-write"
    for bundle_name in "${!BUNDLES[@]}"; do
      local file_path=${BUNDLES[$bundle_name]}
      echo "Upload ${bundle_name}"
      aws s3 cp --cache-control "$CACHE_CONTROL" "$file_path" s3://${BUCKET_NAME}/${bundle_name};
    done
}

invalidate-cloudfront() {
    assume-role "build-stable-cloudfront-invalidation"
    echo "Creating invalidation"
    local -a paths_to_invalidate
    for bundle_name in "${!BUNDLES[@]}"; do
      paths_to_invalidate+=("/$bundle_name")
    done
    aws cloudfront create-invalidation --distribution-id ${DISTRIBUTION_ID} --paths "${paths_to_invalidate[@]}"
}

in-isolation() {
    function=$1
    # subshell to assume-role only for the function
    (
        ${function}
    )
}

assume-role() {
    set +x
    role_name=$1
    temp_credentials=$(aws sts assume-role --role-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${role_name}" --role-session-name AWSCLI-Session)
    export AWS_ACCESS_KEY_ID=$(echo "$temp_credentials" | jq -r .Credentials.AccessKeyId)
    export AWS_SECRET_ACCESS_KEY=$(echo "$temp_credentials" | jq -r .Credentials.SecretAccessKey)
    export AWS_SESSION_TOKEN=$(echo "$temp_credentials" | jq -r .Credentials.SessionToken)
    set -x
}

main
