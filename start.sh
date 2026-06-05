pm2 stop 9router
pm2 delete 9router

git pull
npm install
npx prisma generate
npm run build

cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/

PORT=4000 pm2 start node --name "9router" -- .next/standalone/server.js

pm2 save
