const serve = require('koa-static-server');
const Koa = require('koa');
var app = new Koa();
app.use(serve({ rootDir: 'dist' }));
app.listen(53008);
console.log('listening on port 53008')