var bitcoinjs = require('bitcoinjs-lib')
var braveHapi = require('./brave-hapi')
var crypto = require('crypto')
var debug = new (require('sdebug'))('wallet')
var Joi = require('joi')
var underscore = require('underscore')

var onceonlyP

var Wallet = function (config, runtime) {
  if (!(this instanceof Wallet)) return new Wallet(config)

  if (!config.wallet) throw new Error('config.wallet undefined')

  if (!config.wallet.bitgo) config.wallet = { bitgo: config.wallet }
  this.config = config.wallet
  this.config.environment = config.wallet.bitgo.environment
  this.runtime = runtime
  this.bitgo = new (require('bitgo')).BitGo({ accessToken: config.wallet.bitgo.accessToken,
                                              env: config.wallet.bitgo.environment || 'prod' })
  debug('environment: ' + this.config.environment)

  if (!onceonlyP) {
    onceonlyP = true

    maintenance(this.config, this.runtime)
    setInterval(function () { maintenance(this.config, this.runtime) }.bind(this), 15 * 60 * 1000)
  }
}

Wallet.prototype.create = async function (prefix, label, keychains) {
  var result
  var xpubs = []

  xpubs[0] = underscore.pick(await this.bitgo.keychains().add(underscore.extend({ label: 'user' }, keychains.user)), [ 'xpub' ])
  xpubs[1] = underscore.pick(await this.bitgo.keychains().add({ label: 'unspendable',
                                                                xpub: this.config.bitgo.unspendableXpub }), [ 'xpub' ])
  xpubs[2] = underscore.pick(await this.bitgo.keychains().createBitGo({}), [ 'xpub' ])

  result = await this.bitgo.wallets().add({ label: label,
                                            m: 2,
                                            n: 3,
                                            keychains: xpubs,
                                            enterprise: this.config.bitgo.enterpriseId,
                                            disableTransactionNotifications: true
                                          })
  result.wallet.provider = 'bitgo'

  result.addWebhook({ url: prefix + '/callbacks/bitgo/sink', type: 'transaction', numConfirmations: 1 }, function (err) {
    if (err) debug('wallet addWebhook', { label: label, message: err.toString() })

    result.setPolicyRule({ id: 'com.brave.limit.velocity.30d',
                           type: 'velocityLimit',
                           condition: { type: 'velocity',
                                        amount: 7000000,
                                        timeWindow: 30 * 86400,
                                        groupTags: [],
                                        excludeTags: []
                                      },
                           action: { type: 'deny' } }, function (err) {
      if (err) debug('wallet setPolicyRule', { label: label, message: err.toString() })
    })
  })

  return result
}

Wallet.prototype.balances = async function (info) {
  var f = Wallet.providers[info.provider].balances

  if (!f) throw new Error('provider ' + info.provider + ' balances not supported')
  return await f.bind(this)(info)
}

Wallet.prototype.purchaseBTC = function (info, amount, currency) {
  var f = Wallet.providers[info.provider].purchaseBTC

  if (!f) f = Wallet.providers.coinbase.purchaseBTC
  if (!f) return {}
  return f.bind(this)(info, amount, currency)
}

Wallet.prototype.recurringBTC = function (info, amount, currency) {
  var f = Wallet.providers[info.provider].recurringBTC

  if (!f) f = Wallet.providers.coinbase.recurringBTC
  if (!f) return {}
  return f.bind(this)(info, amount, currency)
}

Wallet.prototype.recover = async function (info, original, passphrase) {
  var f = Wallet.providers[info.provider].recover

  if (!f) throw new Error('provider ' + info.provider + ' recover not supported')
  return await f.bind(this)(info, original, passphrase)
}

Wallet.prototype.compareTx = function (unsignedHex, signedHex) {
  var i
  var signedTx = bitcoinjs.Transaction.fromHex(signedHex)
  var unsignedTx = bitcoinjs.Transaction.fromHex(unsignedHex)

  if ((unsignedTx.version !== signedTx.version) || (unsignedTx.locktime !== signedTx.locktime)) return false

  if (unsignedTx.ins.length !== signedTx.ins.length) return false
  for (i = 0; i < unsignedTx.ins.length; i++) {
    if (!underscore.isEqual(underscore.omit(unsignedTx.ins[i], 'script'), underscore.omit(signedTx.ins[i], 'script'))) {
      return false
    }
  }

  return underscore.isEqual(unsignedTx.outs, signedTx.outs)
}

Wallet.prototype.submitTx = async function (info, signedTx) {
  var f = Wallet.providers[info.provider].submitTx

  if (!f) throw new Error('provider ' + info.provider + ' submitTx not supported')
  return await f.bind(this)(info, signedTx)
}

Wallet.prototype.unsignedTx = async function (info, amount, currency, balance) {
  var f = Wallet.providers[info.provider].unsignedTx

  if (!f) throw new Error('provider ' + info.provider + ' unsignedTx not supported')
  return await f.bind(this)(info, amount, currency, balance)
}

Wallet.prototype.rates = {}

var schema = Joi.object({}).pattern(/timestamp|[A-Z][A-Z][A-Z]/,
                                    Joi.alternatives().try(Joi.date(),
                                                           Joi.object().keys({ last: Joi.number().positive() }).unknown(true)))
                .required()

var maintenance = async function (config, runtime) {
  var rates, result, signature, url, validity
  var timestamp = Math.round(underscore.now() / 1000)
  var prefix = timestamp + '.' + config.bitcoin_average.publicKey
  var suffix = crypto.createHmac('sha256', config.bitcoin_average.secretKey).update(prefix).digest('hex')

  try {
    url = 'https://apiv2.bitcoinaverage.com/indices/global/ticker/all?crypto=BTC'
    signature = prefix + '.' + suffix
    result = await braveHapi.wreck.get(url, { headers: { 'x-signature': signature } })
    if (Buffer.isBuffer(result)) result = result.toString()
// courtesy of https://stackoverflow.com/questions/822452/strip-html-from-text-javascript#822464
    if (result.indexOf('<html>') !== -1) throw new Error(result.replace(/<(?:.|\n)*?>/gm, ''))
    result = JSON.parse(result)
    validity = Joi.validate(result, schema)
    if (validity.error) throw new Error(validity.error)

    rates = {}
    underscore.keys(result).forEach(currency => {
      var rate = result[currency]

      if ((currency.indexOf('BTC') !== 0) || (typeof rate !== 'object') || (!rate.last)) return

      rates[currency.substr(3)] = rate.last
    })

    Wallet.prototype.rates = rates
    debug('BTC key rates', underscore.pick(rates, [ 'USD', 'EUR', 'GBP' ]))
  } catch (ex) {
    debug('maintenance error', ex)
    debug('maintenance details', 'curl -X GET --header "X-Signature: ' + signature + '" ' + url)

    runtime.notify(debug, { text: 'maintenance error: ' + ex.toString() })
  }
}

module.exports = Wallet

Wallet.providers = {}

Wallet.providers.bitgo = {
  balances: async function (info) {
    var wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: info.address })

    return { balance: wallet.balance(),
             spendable: wallet.spendableBalance(),
             confirmed: wallet.confirmedBalance(),
             unconfirmed: wallet.unconfirmedReceives()
           }
  },

  recover: async function (info, original, passphrase) {
    var amount, fee
    var wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: original.address })

    amount = wallet.balance()
    try {
      // NB: this should always throw!
      await wallet.sendCoins({ address: info.address, amount: amount, walletPassphrase: passphrase })
    } catch (ex) {
      fee = ex.result && ex.result.fee
      if (!fee) throw ex

      amount -= fee
      // check for dust
      if (amount <= 2730) return 0

      await wallet.sendCoins({ address: info.address, amount: amount, walletPassphrase: passphrase, fee: fee })
    }

    return amount
  },

  submitTx: async function (info, signedTx) {
    var details, i, result
    var wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: info.address })

    result = await wallet.sendTransaction({ tx: signedTx })

// courtesy of https://stackoverflow.com/questions/33289726/combination-of-async-function-await-settimeout#33292942
    var timeout = function (msec) { return new Promise((resolve) => { setTimeout(resolve, msec) }) }

    for (i = 0; i < 5; i++) {
      try {
        details = await this.bitgo.blockchain().getTransaction({ id: result.hash })
        break
      } catch (ex) {
        debug('getTransaction', ex)
        await timeout(1 * 1000)
        debug('getTransaction', { retry: i + 1, max: 5 })
      }
    }
    underscore.extend(result, { fee: details.fee })

    for (i = details.outputs.length - 1; i >= 0; i--) {
      if (details.outputs[i].account !== this.config.bitgo.settlementAddress) continue

      underscore.extend(result, { address: details.outputs[i].account, satoshis: details.outputs[i].value })
      break
    }

    return result
  },

  unsignedTx: async function (info, amount, currency, balance) {
    var desired, i, minimum, transaction, wallet
    var estimate = await this.bitgo.estimateFee({ numBlocks: 6 })
    var fee = estimate.feePerKb
    var rate = Wallet.prototype.rates[currency.toUpperCase()]
    var recipients = {}

    if (!rate) throw new Error('no such currency: currency')

    desired = (amount / rate) * 1e8
    minimum = Math.floor(desired * 0.90)
    desired = Math.round(desired)
    debug('unsignedTx', { balance: balance, desired: desired, minimum: minimum })
    if (minimum > balance) return

    if (desired > balance) desired = balance

    wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: info.address })
    for (i = 0; i < 2; i++) {
      recipients[this.config.bitgo.settlementAddress] = desired - fee

      try {
        transaction = await wallet.createTransaction({ recipients: recipients, feeRate: estimate.feePerKb })
        debug('unsignedTx', { satoshis: desired, estimate: fee, actual: transaction.fee })
      } catch (ex) {
        debug('createTransaction', ex)
        this.runtime.newrelic.noticeError(ex, { recipients: recipients, feeRate: estimate.feePerKb })
        return
      }
      if (fee <= transaction.fee) break

      fee = transaction.fee
    }

    return underscore.extend(underscore.pick(transaction, [ 'transactionHex', 'unspents', 'fee' ]),
                             { xpub: transaction.walletKeychains[0].xpub })
  }
}

Wallet.providers.coinbase = {
  purchaseBTC: function (info, amount, currency) {
    // TBD: for the moment...
    if (currency !== 'USD') throw new Error('currency ' + currency + ' payment not supported')

    return ({ buyURL: `https://buy.coinbase.com?crypto_currency=BTC` +
                `&code=${this.config.coinbase.widgetCode}` +
                `&amount=${amount}` +
                `&address=${info.address}`
            })
  },

  recurringBTC: function (info, amount, currency) {
    // TBD: for the moment...
    if (currency !== 'USD') throw new Error('currency ' + currency + ' payment not supported')

    return ({ recurringURL: `https://www.coinbase.com/recurring_payments/new?type=send&repeat=monthly` +
                `&amount=${amount}` +
                `&currency=${currency}` +
                `&to=${info.address}`
            })
  }
}
