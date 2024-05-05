export ALIBABA_CLOUD_ACCESS_KEY_ID=
export ALIBABA_CLOUD_ACCESS_KEY_SECRET=

CURRENT_DIR=$(cd $(dirname $0); pwd)
node $CURRENT_DIR/$1/initializer.js
