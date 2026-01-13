#!/bin/sh

USERNAME=`echo $METDX_DEMO_BROKER_URL |awk -F/ '{print $3}' | awk -F@ '{print $1}' | awk -F: '{print $1}'`
PASSWORD=`echo $METDX_DEMO_BROKER_URL |awk -F/ '{print $3}' | awk -F@ '{print $1}' | awk -F: '{print $2}'`

echo "Setting mosquitto authentication"

echo "USERNAME: $USERNAME"
echo "PASSWORD: $PASSWORD"

if [ ! -e "/mosquitto/config/password.txt" ]; then
    echo "Adding metdx-demo users to mosquitto password file"
    mosquitto_passwd -b -c /mosquitto/config/password.txt $USERNAME $PASSWORD
    mosquitto_passwd -b /mosquitto/config/password.txt everyone everyone
    chmod 644 /mosquitto/config/password.txt
else
    echo "Mosquitto password file already exists. Skipping metdx-demo user addition."
fi

sed -i "s#_USERNAME#$USERNAME#" /mosquitto/config/acl.conf
chmod 0700 /mosquitto/config/acl.conf
chmod 0700 /mosquitto/config/password.txt

/usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
