#!/usr/bin/env bash
# Rotate secrets that may have lived in old git history.
# Run from a trusted machine with Heroku CLI logged in for omhl-be.
#
# This script does NOT print new secrets to logs. Generate values yourself,
# then set them on Heroku. Rotating JWT_SECRET logs everyone out (expected).

set -euo pipefail

APP="${HEROKU_APP_NAME:-omhl-be}"

echo "App: $APP"
echo ""
echo "1) Generate a new JWT secret, e.g.:"
echo "   openssl rand -hex 48"
echo "2) Set it (logs out all sessions):"
echo "   heroku config:set JWT_SECRET='<new-value>' -a $APP"
echo ""
echo "3) Rotate mail credentials in Gmail/app-password UI, then:"
echo "   heroku config:set EMAIL_USER='...' EMAIL_PASSWORD='...' -a $APP"
echo ""
echo "4) Rotate Mongo Atlas user password and update:"
echo "   heroku config:set MONGODB_URI='...' -a $APP"
echo ""
echo "5) Rotate Google/Apple OAuth client secrets in their consoles and update"
echo "   matching Heroku config vars (GOOGLE_CLIENT_IDS, Apple keys, etc.)."
echo ""
echo "6) Redeploy / restart:"
echo "   heroku restart -a $APP"
echo ""
echo "Do NOT commit .env or firebase admin JSON. Keep upload keystore props in"
echo "~/.gradle/gradle.properties only."
