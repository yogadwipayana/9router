pm2 stop 9router
pm2 delete 9router

git pull
npm install
npx prisma generate
npm run build
PORT=4000 pm2 start npm --name "9router" -- run start

pm2 save
