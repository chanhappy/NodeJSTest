// import { print } from "pdf-to-printer";


import { execFile } from 'child_process';

var args = ["-print-dialog","-print-settings","fit"];

var path  = require('path')
var dir = path.resolve('./SumatraPDF-3.4.6-32.exe')
console.log("dir:", dir)
execFile(dir, ['./test.pdf'].concat(args), function (err, stdout, stderr) {
    if (err) {
      console.log(`[PdfPrintEx]err:${JSON.stringify(err)}`);
      return;
    }
    console.log(`[PdfPrintEx]stdout:${JSON.stringify(stdout)}`);
    console.log(`[PdfPrintEx]stderr:${JSON.stringify(stderr)}`);
  });




//SumatraPDF-3.4.6-32.exe命令参数参考链接 https://www.sumatrapdfreader.org/docs/Command-line-arguments
// class PrintOptions {
//     //Send a file to the specified printer.
//     printer;

//     //Can provide 90-degree rotation of contents (NOT the rotation of paper which must be pre-set by the choice of printer defaults).
//     //Supported namesportrait or landscape
//     orientation;

//     //Supported names `noscale`, `shrink` and `fit`.
//     scale;

//     //Supported names `duplex`, `duplexshort`, `duplexlong` and `simplex`.
//     side;

//     //Select tray to print to. Number or name.
//     bin;

//     //Specifies the paper size. Supported names `A2`, `A3`, `A4`, `A5`, `A6`, `letter`, `legal`, `tabloid`, `statement`.
//     paperSize;
// }