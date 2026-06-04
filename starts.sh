pm2 stop 9router
pm2 delete 9router

git pull
npm run install
npm run buil
PORT=4000 pm2 run --name "9router" start

pm2 save
