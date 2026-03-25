const sharp = require('sharp');
sharp('back.png').resize(800).toFile('out.png');